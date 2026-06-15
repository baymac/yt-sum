# TODOS

## Security

- Validate PUBLISH_SUMMARY payload schema before storing in chrome.storage.session to guard against oversized or prototype-polluting payloads
  **Priority:** P2

## Performance / Reliability

- Disconnect the MutationObserver and clearInterval in content.js on `pagehide` / navigation away from YouTube to prevent memory accumulation on long sessions
  **Priority:** P2

- Fix storageSet double-registration in Chrome 105+ (promise AND callback both fire); use promise interface exclusively when available to avoid silent error swallowing
  **Priority:** P3

- Log storageGet errors before falling back to `{}` so API-key-missing failures produce a diagnostic rather than a silent empty-storage read
  **Priority:** P3

## Chat

- Give CHAT_PROGRESS/CHAT_MESSAGE a per-turn (and/or video) id, echo it on progress, and drop mismatched chunks; key chat controllers in a Map instead of the single global `activeChatController`. Single-window is guarded today (a video change publishes `loading` → `clearChat` → `chatStreaming=false`), but two side panels in separate windows both receive every stream and the second `handleChat` overwrites the first controller, so streams can bleed across videos/windows.
  **Priority:** P2

- Treat an empty-after-clean transcript (e.g. a video whose only captions are `[Music]`/`[Applause]`) as a transcript failure instead of publishing `transcript_ready` with an empty string — otherwise chat answers from no context and Summarize spends quota on nothing.
  **Priority:** P3

- Throttle the chat streaming re-render: `CHAT_PROGRESS` currently re-runs `formatSummary` over the full accumulated answer and rebuilds the bubble innerHTML on every chunk (O(N*C)). Coalesce with requestAnimationFrame, or stream plain text and format once on completion.
  **Priority:** P3

- Extract the shared CHAT_MESSAGE send + response handling duplicated between `startSummarize` and `sendChatMessage`, and drop the now-dead `context`/`summaryContext.summary` plumbing the panel sends but the background ignores.
  **Priority:** P4

## Testing

- Add E2E tests for the sidebar summarize flow, the "Summarize current video" button, AND the watch-page transcript auto-fetch (`maybeAutoSummarize` / `auto:true`): assert exactly one transcript fetch per videoId, a fresh fetch on SPA navigation, and that no Gemini summarize call fires for the auto path. These content.js flows are SPA/MutationObserver-driven and not unit-testable.
  **Priority:** P3

## Completed

- Sender origin check added to background message hub (v2.1.0.0, 2026-06-05)
- YouTube domain validation for videoUrl in handleGenerate (v2.1.0.0, 2026-06-05)
- Immediate button-disable on click to prevent duplicate Gemini requests (v2.1.0.0, 2026-06-05)
- 2 MB size cap on JSON parsing in transcript.js to prevent content-script freeze (v2.1.0.0, 2026-06-05)
- Dead `block` variable removed from parseGeminiResponse (v2.1.0.0, 2026-06-05)
- Duplicate generationConfig literal extracted to shared constant (v2.1.0.0, 2026-06-05)
