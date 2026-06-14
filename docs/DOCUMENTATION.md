# YouTube Summarizer — Architecture

> v2 rewrite. The summary pipeline is transcript-based with a Gemini
> video-understanding fallback. See `README.md` for install/usage and the module table.

## Components

```
┌── content script (src/content.js) ──────────── youtube.com, isolated world ──┐
│  • injects Summarize buttons (home feed, related tiles, watch-page button)   │
│  • fetches the transcript SAME-ORIGIN (carries the logged-in session)        │
│  • publishes every result to the side panel (one surface — no in-page modal) │
└───────────────────────────────────────────────────────────────────────────────┘
            │ GENERATE_SUMMARY {videoId, videoUrl, title, transcript|null}
            ▼
┌── background service worker (src/background.js) ── holds the Gemini key ──────┐
│  • calls Gemini (transcript-in-prompt, or fileData.fileUri fallback)         │
│  • side-panel pub/sub: storage.session + SUMMARY_READY broadcast             │
└───────────────────────────────────────────────────────────────────────────────┘
            │ SUMMARY_READY {state}
            ▼
┌── side panel (popup.html + src/popup.js) ────────────────────────────────────┐
│  • Summary view (renders the watch-page result) + Settings (key, dark mode)  │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Why the transcript fetch lives in the content script

YouTube caption `baseUrl`s are signed and, increasingly, gated behind a per-fetch PO
token (the `&exp=xpe` marker; symptom: HTTP 200 with an empty body). A server-side or
isolated fetcher can't mint that token. A **content script** on youtube.com issues the
request **same-origin with the user's real cookies and visitor identity**, which is the
most reliable client-side path in 2026 — but still not guaranteed, hence the fallback.

## The summarization ladder

1. Fetch `youtube.com/watch?v=ID`, brace-match `ytInitialPlayerResponse`.
2. Pick a caption track: manual[lang] > asr[lang] > any manual > first (translate if needed).
3. If `baseUrl` has `&exp=xpe` → pot-gated → skip to fallback.
4. Fetch `baseUrl&fmt=json3`; HTTP 200 + empty body → pot-blocked → fallback.
5. Concatenate `events[].segs[].utf8` → transcript text.
6. Background: transcript present → Gemini transcript-in-prompt; absent → Gemini
   `fileData.fileUri` (native video understanding). Model `gemini-2.5-flash`, v1beta.

Irreducible gap: private/members-only videos with no captions are reachable by neither
path; the UI reports this honestly rather than hallucinating.

## Message protocol (`src/lib/messages.js`)

| Message | From → To | Purpose |
|---------|-----------|---------|
| `GENERATE_SUMMARY` | content → bg | run Gemini, respond with `{ok,text,mode}` |
| `PUBLISH_SUMMARY` | content → bg | store + broadcast a sidebar state |
| `SUMMARY_READY` | bg → panel | new sidebar state available |
| `SUMMARY_STATE_REQUEST` | panel → bg | restore last state on open |
| `OPEN_SIDE_PANEL` | content → bg | best-effort `sidePanel.open` on user gesture |
| `SUMMARIZE_IN_SIDEBAR` | panel → content | panel-initiated "Summarize current video" |

## Build & test

`npm run build` (esbuild bundles `src/` → root). `npm test` (vitest+jsdom unit/integration,
incl. real captured fixtures). `npm run e2e` (Playwright loads the unpacked extension and
drives real youtube.com). See `README.md` for the full command list.
