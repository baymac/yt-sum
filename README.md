![AI Generated](https://img.shields.io/badge/🤖_AI-Generated-orange)

# YouTube Video Summarizer

A Chrome extension (Manifest V3) that summarizes YouTube videos from their **full
transcript** using Google's Gemini API — so you can read the summary instead of watching.

- 📝 A **Summarize** button on every video on the home feed → opens a modal with the full summary.
- 🎬 A **Summarize in sidebar** button on the watch page → the summary renders in Chrome's side panel while you keep the video on screen.
- 🧠 Summaries are built from the actual transcript. When a video's captions are unavailable (YouTube pot-token gating, or no captions at all), it **falls back to Gemini's native video understanding** so a normal public video never just fails.
- 🔒 Your API key lives in the background service worker and is never exposed to the page.
- 🌙 Dark mode, markdown rendering, XSS-safe output.

## How it works

```
 click Summarize (home)            open / Summarize on a watch page
        │                                      │
        ▼                                      ▼
 content script: fetchTranscript(videoId)  (same-origin, your logged-in session)
   1. GET youtube.com/watch?v=ID  →  parse ytInitialPlayerResponse
   2. pick caption track (manual > asr, your language)
   3. baseUrl has &exp=xpe (pot-gated)? ─ yes ─┐   200+empty body? ─ yes ─┐
   4. else GET baseUrl&fmt=json3 → transcript  │                         │
        │ transcript text                       │ no transcript            │
        ▼                                        ▼                         ▼
 background service worker (holds the Gemini key)
   transcript present → Gemini generateContent (transcript in prompt)
   no transcript      → Gemini generateContent (fileData.fileUri = video URL)
        │
        ▼
 render: modal (home)   or   side panel summary (watch page)
```

Model: `gemini-2.5-flash` (v1beta `generateContent`). The transcript path is cheap and
fast; the video-understanding fallback is the reliability backstop. Private/members-only
videos with no captions are the one case neither path can reach — the extension says so
clearly instead of guessing.

## Install (load unpacked)

1. `npm install && npm run build && npm run icons` (produces the bundled `content.js`,
   `background.js`, `popup.js` and the icon PNGs).
2. Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and
   select this folder.
3. Click the extension icon to open the side panel, open **⚙️ Settings**, paste your
   **Gemini API key** ([get one free at Google AI Studio](https://aistudio.google.com/app/apikey)),
   and Save.

Requires **Chrome 114+** (side panel API).

## Usage

- **Home feed:** click **📝 Summarize** on any video → a modal shows the summary.
- **Watch page:** click **📝 Summarize in sidebar** under the title, or open the side
  panel and click **Summarize current video** → the summary appears in the side panel.

## Development

```bash
npm run build         # bundle src/ → content.js / background.js / popup.js (esbuild)
npm run build:watch   # rebuild on change
npm test              # unit + integration tests (vitest + jsdom)
npm run test:coverage # coverage report
npm run e2e           # Playwright: load the extension into Chromium, drive real YouTube
npm run icons         # regenerate icon PNGs
```

Source lives in `src/` and is bundled to the extension root. Shared, unit-tested logic is
in `src/lib/`:

| File | Responsibility |
|------|----------------|
| `lib/transcript.js` | watch-page parse, caption-track pick, pot-gate detection, json3 parse |
| `lib/summarize.js`  | Gemini request (both modes), retry/backoff, response parse |
| `lib/youtube-dom.js`| video-id extraction, title strategies, button insertion |
| `lib/markdown.js`   | markdown → safe HTML, URL sanitization |
| `lib/modal.js`      | in-page summary modal |
| `lib/storage.js` / `lib/messages.js` | storage wrappers / message protocol |

### Testing against your real YouTube session

Logged-out YouTube has an empty home feed, so the E2E run can optionally use your real
cookies:

```bash
node tests/e2e/import-brave-cookies.mjs   # exports Brave's youtube.com cookies (one Keychain prompt)
npm run e2e                               # now runs logged in
```

Cookies are written to `.context/youtube-cookies.json`, which is gitignored. It holds
live session credentials — delete it when you're done (`rm .context/youtube-cookies.json`).
The core injection/modal e2e tests use the search-results page and pass without it; only the
"logged-in home feed" test needs a session (it skips when absent).

## Free alternative — `/yt-summarize` for Claude Code

Don't want to use a paid Gemini key? `.claude/commands/yt-summarize.md` is a Claude Code
slash command that fetches a video's transcript with the free
[`youtube-transcript-api`](https://github.com/jdepoix/youtube-transcript-api) and has
**Claude itself** summarize it — no API key, modeled on the
[skills.sh youtube-summarizer skill](https://www.skills.sh/sickn33/antigravity-awesome-skills/youtube-summarizer).

```
/yt-summarize https://www.youtube.com/watch?v=VIDEO_ID
```

To use it anywhere, copy it to your global commands dir:

```bash
cp .claude/commands/yt-summarize.md ~/.claude/commands/
```

It keeps the library in an isolated venv (so it works on PEP-668 "externally managed"
Python) and handles both the library's old and new APIs. `scripts/yt-transcript.py` is the
standalone extractor it uses.

## Privacy & security

- The API key is stored in Chrome sync storage and used only by the background service
  worker — it never enters page or content-script context.
- Transcript fetches are same-origin requests to youtube.com from your own session.
- All rendered summary/title text is HTML-escaped; links are protocol-sanitized.

## License

MIT.
