(() => {
  // src/lib/summarize.js
  var GEMINI_MODEL = "gemini-2.5-flash";
  var STREAM_ENDPOINT = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
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
  var GENERATION_CONFIG = { temperature: 0.3, maxOutputTokens: 8192 };
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
        generationConfig: GENERATION_CONFIG
      };
    }
    return {
      contents: [
        {
          role: "user",
          parts: [{ text: buildTranscriptPrompt({ title, transcript }) }]
        }
      ],
      generationConfig: GENERATION_CONFIG
    };
  }
  var isTransient = (status) => status === 429 || status >= 500;
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function callGeminiStreaming({
    apiKey,
    model = GEMINI_MODEL,
    body,
    onChunk,
    fetchImpl,
    sleepImpl = sleep,
    maxAttempts = 3,
    signal
  }) {
    const f = fetchImpl || globalThis.fetch;
    let lastError = "Request failed.";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (attempt > 0) await sleepImpl(2 ** (attempt - 1) * 1e3);
      let res;
      try {
        res = await f(STREAM_ENDPOINT(model), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify(body),
          signal
        });
      } catch (e) {
        if (signal?.aborted || e?.name === "AbortError") throw e;
        lastError = `Network error: ${e?.message || e}`;
        continue;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const message = errData?.error?.message || res.statusText || "API error";
        if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(message)) {
          throw new Error("Your Gemini API key is invalid. Update it in the side panel settings.");
        }
        if (!isTransient(res.status)) throw new Error(message);
        lastError = message;
        continue;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const json = JSON.parse(data);
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (text) {
              accumulated += text;
              onChunk?.(accumulated);
            }
          } catch (_) {
          }
        }
      }
      return accumulated;
    }
    throw new Error(`Gemini is busy right now. ${lastError}`);
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
    SUMMARIZE_IN_SIDEBAR: "SUMMARIZE_IN_SIDEBAR",
    SUMMARY_PROGRESS: "SUMMARY_PROGRESS",
    CANCEL_SUMMARY: "CANCEL_SUMMARY",
    CHAT_MESSAGE: "CHAT_MESSAGE",
    CHAT_PROGRESS: "CHAT_PROGRESS",
    CHAT_STOP: "CHAT_STOP"
  };
  var SESSION_KEY = "currentSummary";

  // src/background.js
  var CHAT_GENERATION_CONFIG = { temperature: 0.5, maxOutputTokens: 4096 };
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
  var YOUTUBE_DOMAIN_RE = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\//;
  var activeRequests = /* @__PURE__ */ new Map();
  var activeChatController = null;
  function cancelRequest(videoId) {
    const controller = videoId && activeRequests.get(videoId);
    if (controller) {
      controller.abort();
      activeRequests.delete(videoId);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    switch (message?.type) {
      case MSG.GENERATE_SUMMARY:
        handleGenerate(message, sender, sendResponse);
        return true;
      // async response
      case MSG.CANCEL_SUMMARY:
        cancelRequest(message.videoId);
        sendResponse?.({ ok: true });
        return false;
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
      case MSG.CHAT_MESSAGE:
        handleChat(message, sender, sendResponse);
        return true;
      // async response
      case MSG.CHAT_STOP:
        if (activeChatController) {
          activeChatController.abort();
          activeChatController = null;
        }
        sendResponse?.({ ok: true });
        return false;
      default:
        return false;
    }
  });
  async function handleGenerate(message, sender, sendResponse) {
    try {
      if (message.videoUrl && !YOUTUBE_DOMAIN_RE.test(message.videoUrl)) {
        sendResponse({ ok: false, error: "Invalid video URL." });
        return;
      }
      const { geminiApiKey } = await storageGet(["geminiApiKey"]);
      if (!geminiApiKey) {
        sendResponse({ ok: false, error: "Set your Gemini API key in the side panel first." });
        return;
      }
      const mode = message.transcript?.trim() ? "transcript" : "video";
      const body = buildRequestBody({
        mode,
        title: message.title,
        transcript: message.transcript,
        videoUrl: message.videoUrl
      });
      const tabId = sender?.tab?.id;
      const { target, token, videoId } = message;
      const controller = new AbortController();
      if (videoId) activeRequests.set(videoId, controller);
      let finalText = "";
      try {
        finalText = await callGeminiStreaming({
          apiKey: geminiApiKey,
          model: GEMINI_MODEL,
          body,
          signal: controller.signal,
          onChunk: (accumulated) => {
            if (tabId != null) {
              chrome.tabs.sendMessage(
                tabId,
                { type: MSG.SUMMARY_PROGRESS, text: accumulated, mode, target, token },
                () => {
                  void chrome.runtime?.lastError;
                }
              );
            }
          }
        });
      } catch (e) {
        if (controller.signal.aborted || e?.name === "AbortError") {
          sendResponse({ ok: false, cancelled: true });
          return;
        }
        sendResponse({ ok: false, error: e?.message || "Failed to summarize." });
        return;
      } finally {
        if (videoId) activeRequests.delete(videoId);
      }
      if (!finalText) {
        sendResponse({ ok: false, error: "Gemini returned no summary (response may have been blocked)." });
        return;
      }
      sendResponse({ ok: true, text: finalText, mode });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || "Unexpected error generating summary." });
    }
  }
  function buildChatContents(history) {
    return history.map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.text }]
    }));
  }
  async function handleChat(message, sender, sendResponse) {
    try {
      const { geminiApiKey } = await storageGet(["geminiApiKey"]);
      if (!geminiApiKey) {
        sendResponse({ ok: false, error: "Set your Gemini API key in the side panel first." });
        return;
      }
      const { history } = message;
      if (!history?.length) {
        sendResponse({ ok: false, error: "No message to send." });
        return;
      }
      const contents = buildChatContents(history);
      const body = {
        contents,
        generationConfig: CHAT_GENERATION_CONFIG
      };
      activeChatController = new AbortController();
      const signal = activeChatController.signal;
      try {
        const finalText = await callGeminiStreaming({
          apiKey: geminiApiKey,
          model: GEMINI_MODEL,
          body,
          signal,
          onChunk: (accumulated) => {
            try {
              chrome.runtime.sendMessage(
                { type: MSG.CHAT_PROGRESS, text: accumulated },
                () => {
                  void chrome.runtime?.lastError;
                }
              );
            } catch (_) {
            }
          }
        });
        sendResponse({ ok: true, text: finalText });
      } catch (e) {
        if (activeChatController?.signal.aborted || e?.name === "AbortError") {
          sendResponse({ ok: false, cancelled: true });
          return;
        }
        sendResponse({ ok: false, error: e?.message || "Chat failed." });
      } finally {
        activeChatController = null;
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || "Unexpected chat error." });
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
