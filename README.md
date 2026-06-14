![AI Generated](https://img.shields.io/badge/🤖_AI-Generated-orange)

# YouTube Video Summarizer

A Chrome extension (Manifest V3) that summarizes YouTube videos from their **full
transcript** using Google's Gemini API — so you can read the summary instead of watching.

## Features

- **📝 Summarize button on every video** — home feed tiles, watch-page related videos, and
  the watch page itself. One click summarizes that video.
- **Everything in the side panel.** Summaries render in Chrome's side panel, so you can keep
  the video on screen while you read. (There's also a **Summarize current video** button
  inside the panel.)
- **Transcript-first, with a fallback.** Summaries are built from the real transcript. When
  captions are unavailable (YouTube pot-token gating, or no captions at all), it falls back
  to Gemini's native video understanding, so a normal public video never just fails.
- **Streaming output.** The summary streams in token-by-token instead of waiting for the full
  response.
- **Safe by default.** Your API key lives in the background service worker and never reaches
  the page. Rendered text is HTML-escaped; links are protocol-sanitized. Dark mode included.

Model: `gemini-2.5-flash` (v1beta `streamGenerateContent`). The transcript path is cheap and
fast; the video-understanding fallback is the reliability backstop. Private/members-only
videos with no captions are the one case neither path can reach — the extension says so
clearly instead of guessing.

## Setup (load unpacked)

Requires **Chrome 114+** (side panel API) and **Node 18+**.

1. Build the extension:

   ```bash
   npm install
   npm run build && npm run icons
   ```

   This produces the bundled `content.js`, `background.js`, `popup.js`, and the icon PNGs.

2. Load it into Chrome:
   - Open `chrome://extensions/`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked** and select this folder

3. Add your Gemini key:
   - Click the extension icon to open the side panel
   - Open **⚙️ Settings**, paste your **Gemini API key**
     ([get one free at Google AI Studio](https://aistudio.google.com/app/apikey)), and Save

## Usage

- **Any video tile** (home feed or related videos): click **📝 Summarize** → the summary
  opens in the side panel.
- **Watch page:** click **📝 Summarize** under the title, or open the side panel and click
  **Summarize current video**.

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
| `lib/transcript.js`  | watch-page parse, caption-track pick, pot-gate detection, json3 parse |
| `lib/summarize.js`   | Gemini request (transcript + video-understanding modes), streaming, retry/backoff |
| `lib/youtube-dom.js` | video-id extraction, title strategies, button insertion |
| `lib/markdown.js`    | markdown → safe HTML, URL sanitization |
| `lib/storage.js` / `lib/messages.js` | storage wrappers / message protocol |

### Testing against your real YouTube session

Logged-out YouTube has an empty home feed, so the E2E run can optionally use your real
cookies:

```bash
node tests/e2e/import-brave-cookies.mjs   # exports Brave's youtube.com cookies (one Keychain prompt)
npm run e2e                               # now runs logged in
```

Cookies are written to `.context/youtube-cookies.json` (gitignored). It holds live session
credentials — delete it when you're done (`rm .context/youtube-cookies.json`). The core
injection e2e tests use the search-results page and pass without it; only the "logged-in home
feed" test needs a session (it skips when absent).

## Free alternative — `/yt-summarize` for Claude Code

Don't want to use a paid Gemini key? `.claude/commands/yt-summarize.md` is a Claude Code
slash command that fetches a video's transcript with the free
[`youtube-transcript-api`](https://github.com/jdepoix/youtube-transcript-api) and has
**Claude itself** summarize it — no API key.

```
/yt-summarize https://www.youtube.com/watch?v=VIDEO_ID
```

To use it anywhere, copy it to your global commands dir:

```bash
cp .claude/commands/yt-summarize.md ~/.claude/commands/
```

`scripts/yt-transcript.py` is the standalone extractor it uses (kept in an isolated venv, so
it works on PEP-668 "externally managed" Python).

## Docs

- [Architecture](docs/DOCUMENTATION.md) — component diagram, summarization ladder, message protocol
- [Security model](docs/SECURITY.md) — XSS prevention, URL sanitization, API key isolation

## License

MIT.
