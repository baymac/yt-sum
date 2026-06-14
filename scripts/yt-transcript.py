#!/usr/bin/env python3
"""Print a YouTube video's transcript as plain text — free, no API key.

Usage:
    yt-transcript.py <url-or-id> [lang]      # print transcript text
    yt-transcript.py <url-or-id> --list      # list available transcripts

Backs the /yt-summarize Claude Code command. Uses the free, open-source
youtube-transcript-api and supports both its <0.7 static API
(YouTubeTranscriptApi.get_transcript) and its >=0.7 instance API
(YouTubeTranscriptApi().fetch).
"""
import re
import sys


def video_id(s: str):
    s = s.strip()
    m = re.search(r"(?:v=|/shorts/|/embed/|youtu\.be/)([A-Za-z0-9_-]{11})", s)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s
    return None


def _err(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def list_transcripts(vid):
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    listing = api.list(vid) if hasattr(api, "list") else YouTubeTranscriptApi.list_transcripts(vid)
    for t in listing:
        kind = "auto" if t.is_generated else "manual"
        print(f"{t.language_code}\t{kind}\t{t.language}")


def get_text(vid, lang):
    from youtube_transcript_api import YouTubeTranscriptApi

    langs = [lang, "en"] if lang != "en" else ["en"]

    # >=0.7 instance API: api.fetch(...) -> iterable of snippets with .text
    api = YouTubeTranscriptApi()
    if hasattr(api, "fetch"):
        fetched = api.fetch(vid, languages=langs)
        return " ".join(snippet.text for snippet in fetched)

    # <0.7 static API: list of {"text": ...} dicts
    data = YouTubeTranscriptApi.get_transcript(vid, languages=langs)
    return " ".join(entry["text"] for entry in data)


def main(argv):
    if len(argv) < 2:
        _err("Usage: yt-transcript.py <url-or-id> [lang|--list]")

    vid = video_id(argv[1])
    if not vid:
        _err(f"Could not parse a YouTube video id from: {argv[1]}")

    second = argv[2] if len(argv) > 2 else "en"

    try:
        if second == "--list":
            list_transcripts(vid)
        else:
            text = get_text(vid, second).strip()
            if not text:
                _err(f"Transcript for {vid} was empty.")
            print(text)
    except ImportError:
        _err(
            "youtube-transcript-api is not installed.\n"
            "Install it with: pip install youtube-transcript-api"
        )
    except Exception as e:  # TranscriptsDisabled / NoTranscriptFound / network
        name = type(e).__name__
        if name in ("TranscriptsDisabled", "NoTranscriptFound", "VideoUnavailable"):
            _err(f"No usable transcript for {vid}: {name}. The video may have captions disabled, be private, or have none.")
        _err(f"Error fetching transcript for {vid}: {name}: {e}")


if __name__ == "__main__":
    main(sys.argv)
