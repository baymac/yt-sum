---
description: Summarize a YouTube video from its transcript using Claude itself — free, no API key
argument-hint: <youtube-url-or-id> [lang]
allowed-tools: Bash(python3:*), Bash(pip:*), Bash(pip3:*), Write
---

The user wants a summary of this YouTube video — for **free**, using its transcript and
you (Claude) as the summarizer. No paid API. The video:

`$ARGUMENTS`

Follow these steps:

## 1. Fetch the transcript

Run this. It keeps the free `youtube-transcript-api` in an isolated venv (so it works
even on PEP-668 "externally managed" Python like Homebrew's), then prints the transcript.
It handles both the library's old (`get_transcript`) and new (`fetch`) APIs:

```bash
VENV="$HOME/.cache/yt-summarize/venv"; PY="$VENV/bin/python3"
if ! "$PY" -c "import youtube_transcript_api" 2>/dev/null; then
  python3 -m venv "$VENV" && "$PY" -m pip install -q --upgrade pip youtube-transcript-api
fi
"$PY" - "$ARGUMENTS" <<'PY'
import re, sys
from youtube_transcript_api import YouTubeTranscriptApi

arg = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
parts = arg.split()
target = parts[0] if parts else ""
lang = parts[1] if len(parts) > 1 else "en"

m = re.search(r"(?:v=|/shorts/|/embed/|youtu\.be/)([A-Za-z0-9_-]{11})", target)
vid = m.group(1) if m else (target if re.fullmatch(r"[A-Za-z0-9_-]{11}", target) else None)
if not vid:
    sys.exit(f"Could not parse a YouTube video id from: {target!r}")

langs = [lang, "en"] if lang != "en" else ["en"]
try:
    api = YouTubeTranscriptApi()
    if hasattr(api, "fetch"):
        text = " ".join(s.text for s in api.fetch(vid, languages=langs))
    else:
        text = " ".join(e["text"] for e in YouTubeTranscriptApi.get_transcript(vid, languages=langs))
except Exception as e:
    sys.exit(f"No usable transcript for {vid}: {type(e).__name__}. "
             "Captions may be disabled, the video private, or none exist.")

text = text.strip()
if not text:
    sys.exit(f"Transcript for {vid} was empty.")
print(f"VIDEO_ID: {vid}")
print(f"CHARS: {len(text)}")
print("--- TRANSCRIPT ---")
print(text)
PY
```

## 2. Handle failure honestly

If the script exits with an error (captions disabled, private video, or none), tell the
user plainly and **stop**. Do not invent a summary from the title.

## 3. Summarize it yourself (this is the free part)

Read the transcript that was printed above into context and write a comprehensive,
faithful Markdown summary **yourself** — do not call any external summarization API:

- A title line and the source URL.
- **TL;DR** — 2-3 sentences capturing the core message.
- **Key Points** — ordered bullets with the concrete facts, numbers, names, and
  conclusions (not vague descriptions).
- **Details** — a topic-by-topic walkthrough so the reader gets everything important
  without watching.
- **Takeaways** — the most useful insights or action items.

Stay grounded in the transcript; do not add claims it doesn't support.

## 4. Offer to save

Offer to save the summary to `yt-summary-<VIDEO_ID>-<today>.md` (use the Write tool only
if the user agrees).
