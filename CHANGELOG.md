# Changelog

All notable changes to this project will be documented in this file.

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
