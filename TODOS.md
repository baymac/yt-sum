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

## Testing

- Add E2E tests for sidebar summarize flow, toast display, and panel "Summarize current video" button (content.js and popup.js paths not covered by unit tests)
  **Priority:** P3

## Completed

- Sender origin check added to background message hub (v2.1.0.0, 2026-06-05)
- YouTube domain validation for videoUrl in handleGenerate (v2.1.0.0, 2026-06-05)
- Immediate button-disable on click to prevent duplicate Gemini requests (v2.1.0.0, 2026-06-05)
- 2 MB size cap on JSON parsing in transcript.js to prevent content-script freeze (v2.1.0.0, 2026-06-05)
- Dead `block` variable removed from parseGeminiResponse (v2.1.0.0, 2026-06-05)
- Duplicate generationConfig literal extracted to shared constant (v2.1.0.0, 2026-06-05)
