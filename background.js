(() => {
  // src/lib/summarize.js
  var GEMINI_MODEL = "gemini-2.5-flash";
  var ENDPOINT = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  var MAX_TRANSCRIPT_CHARS = 2e5;
  var SUMMARY_INSTRUCTION = `You are summarizing a YouTube video so the reader does NOT have to watch it. Produce a clear, well-structured Markdown summary with these sections:

## TL;DR
2-3 sentences capturing the core message.

## Key Points
A bulleted list of the main points, arguments, or steps in the order they appear. Be specific \u2014 include the concrete facts, numbers, names, and conclusions, not vague descriptions.

## Details
A few short paragraphs walking through the substance so the reader gets everything important without watching.

## Takeaways
The most useful insights or action items.

Write in plain, direct language. Do not invent content that isn't supported by the source.`;
  function clampTranscript(text, max = MAX_TRANSCRIPT_CHARS) {
    if (!text) return "";
    if (text.length <= max) return text;
    return `${text.slice(0, max)}

[transcript truncated for length]`;
  }
  function buildTranscriptPrompt({ title, transcript }) {
    const head = title ? `Video title: ${title}

` : "";
    return `${SUMMARY_INSTRUCTION}

${head}TRANSCRIPT:
${clampTranscript(transcript)}`;
  }
  function buildRequestBody({ mode, title, transcript, videoUrl }) {
    if (mode === "video") {
      const ask = title ? `${SUMMARY_INSTRUCTION}

The video title is: ${title}` : SUMMARY_INSTRUCTION;
      return {
        contents: [
          {
            role: "user",
            parts: [{ text: ask }, { file_data: { file_uri: videoUrl } }]
          }
        ],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
      };
    }
    return {
      contents: [
        {
          role: "user",
          parts: [{ text: buildTranscriptPrompt({ title, transcript }) }]
        }
      ],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
    };
  }
  function parseGeminiResponse(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const text = parts.map((p) => p.text || "").join("").trim();
      if (text) return text;
    }
    const block = data?.promptFeedback?.blockReason;
    if (block) return null;
    return null;
  }
  var isTransient = (status) => status === 429 || status >= 500;
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function callGemini({
    apiKey,
    model = GEMINI_MODEL,
    body,
    fetchImpl,
    sleepImpl = sleep,
    maxAttempts = 3
  }) {
    const f = fetchImpl || globalThis.fetch;
    let lastError = "Request failed.";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleepImpl(2 ** (attempt - 1) * 1e3);
      let res;
      try {
        res = await f(ENDPOINT(model), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify(body)
        });
      } catch (e) {
        lastError = `Network error: ${e?.message || e}`;
        continue;
      }
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const text = parseGeminiResponse(data);
        if (text) return { ok: true, text };
        return {
          ok: false,
          error: "Gemini returned no summary (the response may have been blocked or empty)."
        };
      }
      const errData = await res.json().catch(() => ({}));
      const message = errData?.error?.message || res.statusText || "API error";
      if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(message)) {
        return { ok: false, error: "Your Gemini API key is invalid. Update it in the side panel settings." };
      }
      if (!isTransient(res.status)) {
        return { ok: false, error: message };
      }
      lastError = message;
    }
    return { ok: false, error: `Gemini is busy right now. ${lastError}` };
  }
  async function summarize({
    apiKey,
    videoUrl,
    title,
    transcript,
    model = GEMINI_MODEL,
    fetchImpl,
    sleepImpl
  }) {
    if (!apiKey) {
      return { ok: false, error: "Set your Gemini API key in the side panel first." };
    }
    const mode = transcript && transcript.trim() ? "transcript" : "video";
    const body = buildRequestBody({ mode, title, transcript, videoUrl });
    const result = await callGemini({ apiKey, model, body, fetchImpl, sleepImpl });
    if (result.ok) return { ok: true, text: result.text, mode };
    return result;
  }

  // src/lib/storage.js
  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        const maybePromise = chrome.storage.sync.get(keys, (result) => {
          resolve(result || {});
        });
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then((r) => resolve(r || {})).catch(() => resolve({}));
        }
      } catch (_) {
        resolve({});
      }
    });
  }

  // src/lib/messages.js
  var MSG = {
    GENERATE_SUMMARY: "GENERATE_SUMMARY",
    PUBLISH_SUMMARY: "PUBLISH_SUMMARY",
    SUMMARY_READY: "SUMMARY_READY",
    SUMMARY_STATE_REQUEST: "SUMMARY_STATE_REQUEST",
    OPEN_SIDE_PANEL: "OPEN_SIDE_PANEL",
    SUMMARIZE_IN_SIDEBAR: "SUMMARIZE_IN_SIDEBAR"
  };
  var SESSION_KEY = "currentSummary";

  // src/background.js
  async function setupSidePanel() {
    try {
      await chrome.sidePanel?.setOptions?.({ path: "popup.html", enabled: true });
      await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
    } catch (err) {
      console.error("[YT Summarizer] side panel setup:", err);
    }
  }
  chrome.runtime.onInstalled.addListener(setupSidePanel);
  chrome.runtime.onStartup.addListener(setupSidePanel);
  async function setSessionState(state) {
    try {
      await chrome.storage.session.set({ [SESSION_KEY]: state });
    } catch (e) {
      console.error("[YT Summarizer] session set:", e);
    }
    try {
      chrome.runtime.sendMessage({ type: MSG.SUMMARY_READY, state }, () => {
        void chrome.runtime?.lastError;
      });
    } catch (_) {
    }
  }
  async function getSessionState() {
    try {
      const r = await chrome.storage.session.get([SESSION_KEY]);
      return r?.[SESSION_KEY] || null;
    } catch (_) {
      return null;
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message?.type) {
      case MSG.GENERATE_SUMMARY:
        handleGenerate(message, sendResponse);
        return true;
      // async response
      case MSG.PUBLISH_SUMMARY:
        setSessionState(message.payload);
        sendResponse?.({ ok: true });
        return false;
      case MSG.OPEN_SIDE_PANEL:
        openSidePanel(sender).then((opened) => sendResponse({ ok: true, opened }));
        return true;
      // async response
      case MSG.SUMMARY_STATE_REQUEST:
        getSessionState().then((state) => sendResponse({ ok: true, state }));
        return true;
      // async response
      default:
        return false;
    }
  });
  async function handleGenerate(message, sendResponse) {
    try {
      const { geminiApiKey } = await storageGet(["geminiApiKey"]);
      const result = await summarize({
        apiKey: geminiApiKey,
        videoUrl: message.videoUrl,
        title: message.title,
        transcript: message.transcript
      });
      sendResponse(result);
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || "Unexpected error generating summary." });
    }
  }
  async function openSidePanel(sender) {
    try {
      const opts = {};
      if (sender?.tab?.windowId != null) opts.windowId = sender.tab.windowId;
      else if (sender?.tab?.id != null) opts.tabId = sender.tab.id;
      await chrome.sidePanel?.open?.(opts);
      return true;
    } catch (e) {
      console.debug("[YT Summarizer] sidePanel.open skipped:", e?.message || e);
      return false;
    }
  }
})();
