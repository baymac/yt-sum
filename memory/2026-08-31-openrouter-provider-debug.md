# OpenRouter provider debug report — 2026-08-31

- **Symptom:** A Gemini quota error appeared while the side-panel settings showed OpenRouter and `qwen/qwen3.8-flash`.
- **Root cause:** The current provider code cannot emit that Gemini error after `aiProvider: "openrouter"` has been saved: it reads `chrome.storage.sync` on every request and selects the OpenRouter streaming client. The observed behavior therefore requires either unsaved settings or a stale Chrome extension service worker running the previous Gemini-only bundle.
- **Evidence:** `qwen/qwen3.8-flash` is present in OpenRouter's public model list; the OpenRouter routing regression test passes. The Gemini quota string is only emitted by the Gemini client.
- **Resolution:** Save the OpenRouter settings, then reload the unpacked extension from `chrome://extensions` and reopen the side panel.
- **Status:** DONE_WITH_CONCERNS — browser runtime state cannot be inspected from this workspace.
