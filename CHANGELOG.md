# Changelog

All notable changes to this project will be documented in this file.

## [2.2.0.0] - 2026-06-16

### Added
- Chat copilot in the side panel: ask follow-up questions about the video and get streaming answers, with a Stop button to interrupt a reply mid-stream. The transcript is used as context automatically, so you can start asking before (or instead of) generating a summary.
- Watch pages now fetch the transcript automatically in the background, so the side panel is ready the moment you open it. No Gemini quota is spent until you click Summarize or send a chat message.
- Copy buttons on chat replies and on the transcript prompt for one-click copy to the clipboard.

### Changed
- Opening Settings now preserves the video title and the chat layout, and restores both when you go back.
- The chat box is focused automatically when a video is ready and is labeled for screen readers; chat error messages are announced to assistive tech.

### Fixed
- The side-panel script (`popup.js`) now ships as readable text instead of being flagged as a binary file, so its diffs are reviewable. This was caused by raw control bytes in the markdown URL sanitizer, now written as escape sequences (same behavior: `javascript:`/`data:` and control-character URLs are still rejected).

## [2.1.0.0] - 2026-06-05

### Added
- Full test suite: 107 unit tests across all library modules (transcript, summarize, markdown, modal, storage, youtube-dom, background)
- ESBuild build system with watch mode (`npm run build`, `npm run build:watch`)
- Icon generation script producing 16×16, 48×48, and 128×128 extension icons
- Extension icons at all three required sizes
- `SECURITY.md` documenting the extension's security model and data flow
- `DOCUMENTATION.md` with full feature and API reference

### Changed
- Source code reorganized into `src/lib/` modules for clearer separation of concerns
- Gemini API key is now validated as belonging to a YouTube domain before video-mode requests, preventing the key from being used against arbitrary URLs
- Background message handler now validates sender identity (`chrome.runtime.id`) before processing any message
- Summarize button in the side panel is disabled immediately on click to prevent duplicate requests
- JSON parsing in the transcript fetcher is capped at 2 MB to prevent the content script from freezing on large or malformed watch-page responses
- `parseGeminiResponse` simplified by removing dead code path
- `buildRequestBody` extracts shared `generationConfig` constant to avoid duplication

### Fixed
- Sender origin check prevents external pages from invoking the background's Gemini API key via crafted messages
- Double-click on "Summarize" no longer dispatches multiple concurrent Gemini requests
