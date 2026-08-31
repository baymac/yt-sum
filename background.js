(() => {
  // src/lib/summarize.js
  var GEMINI_MODEL = "gemini-2.5-flash";
  var OPENROUTER_DEFAULT_MODEL = "openai/gpt-4o-mini";
  var STREAM_ENDPOINT = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
  var OPENROUTER_STREAM_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
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
  function buildOpenRouterRequestBody({ model = OPENROUTER_DEFAULT_MODEL, body }) {
    const messages = (body?.contents || []).map((content) => {
      if ((content.parts || []).some((part) => part.file_data)) {
        throw new Error("OpenRouter can summarize transcripts and pages, but cannot use Gemini's YouTube video fallback.");
      }
      const text = (content.parts || []).filter((part) => typeof part.text === "string").map((part) => part.text).join("\n");
      if (!text) {
        throw new Error("OpenRouter can summarize transcripts and pages, but cannot use Gemini's YouTube video fallback.");
      }
      return { role: content.role === "model" ? "assistant" : "user", content: text };
    });
    return {
      model: model.trim() || OPENROUTER_DEFAULT_MODEL,
      messages,
      temperature: body?.generationConfig?.temperature,
      max_tokens: body?.generationConfig?.maxOutputTokens,
      stream: true
    };
  }
  async function callOpenRouterStreaming({
    apiKey,
    model = OPENROUTER_DEFAULT_MODEL,
    body,
    onChunk,
    fetchImpl,
    sleepImpl = sleep,
    maxAttempts = 3,
    signal
  }) {
    const f = fetchImpl || globalThis.fetch;
    let lastError = "Request failed.";
    const requestBody = buildOpenRouterRequestBody({ model, body });
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (attempt > 0) await sleepImpl(2 ** (attempt - 1) * 1e3);
      let res;
      try {
        res = await f(OPENROUTER_STREAM_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody),
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
        if (res.status === 401 || res.status === 403) {
          throw new Error("Your OpenRouter API key is invalid. Update it in the side panel settings.");
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
            const text = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof text === "string" && text) {
              accumulated += text;
              onChunk?.(accumulated);
            }
          } catch (_) {
          }
        }
      }
      return accumulated;
    }
    throw new Error(`OpenRouter is busy right now. ${lastError}`);
  }

  // src/lib/page.js
  var MAX_PAGE_CHARS = 2e5;
  function clampPageText(text, max = MAX_PAGE_CHARS) {
    if (!text) return "";
    if (text.length <= max) return text;
    return `${text.slice(0, max)}

[content truncated for length]`;
  }
  function extractPageContent() {
    const STRIP = 'script,style,noscript,template,nav,header,footer,aside,form,iframe,svg,button,select,[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"]';
    const root = document.querySelector("article") || document.querySelector("main") || document.querySelector('[role="main"]') || document.body;
    let text = "";
    if (root) {
      const clone = root.cloneNode(true);
      clone.querySelectorAll(STRIP).forEach((el) => el.remove());
      text = (clone.innerText || clone.textContent || "").replace(/[ \t ]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    const h1 = document.querySelector("h1");
    const title = (h1 && (h1.innerText || h1.textContent) || "").replace(/\s+/g, " ").trim() || (document.title || "").replace(/\s+/g, " ").trim() || location.href;
    return { title, text, url: location.href };
  }

  // src/lib/youtube-dom.js
  function isWatchUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url, "https://www.youtube.com");
      return u.pathname === "/watch" && u.searchParams.has("v");
    } catch (_) {
      return /\/watch\?(?:.*&)?v=/.test(url);
    }
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
    CHAT_STOP: "CHAT_STOP",
    SAVE_CHAT: "SAVE_CHAT"
  };
  var TAB_STATES_KEY = "tabStates";

  // src/background.js
  var CHAT_GENERATION_CONFIG = { temperature: 0.5, maxOutputTokens: 4096 };
  async function getProvider() {
    const { aiProvider, geminiApiKey, openRouterApiKey, openRouterModel } = await storageGet([
      "aiProvider",
      "geminiApiKey",
      "openRouterApiKey",
      "openRouterModel"
    ]);
    if (aiProvider === "openrouter") {
      return {
        id: "openrouter",
        apiKey: openRouterApiKey,
        model: openRouterModel?.trim() || OPENROUTER_DEFAULT_MODEL,
        name: "OpenRouter"
      };
    }
    return { id: "gemini", apiKey: geminiApiKey, model: GEMINI_MODEL, name: "Gemini" };
  }
  function missingKeyError(provider) {
    return `Set your ${provider.name} API key in the side panel settings first.`;
  }
  function streamWithProvider(provider, options) {
    if (provider.id === "openrouter") {
      return callOpenRouterStreaming({ ...options, apiKey: provider.apiKey, model: provider.model });
    }
    return callGeminiStreaming({ ...options, apiKey: provider.apiKey, model: provider.model });
  }
  async function setupSidePanel() {
    try {
      await chrome.sidePanel?.setOptions?.({ path: "popup.html", enabled: true });
      await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
    } catch (err) {
      console.error("[Summarizer] side panel setup:", err);
    }
  }
  chrome.runtime.onInstalled.addListener(setupSidePanel);
  chrome.runtime.onStartup.addListener(setupSidePanel);
  async function getAllTabStates() {
    try {
      const r = await chrome.storage.session.get([TAB_STATES_KEY]);
      return r?.[TAB_STATES_KEY] || {};
    } catch (_) {
      return {};
    }
  }
  async function setAllTabStates(all) {
    try {
      await chrome.storage.session.set({ [TAB_STATES_KEY]: all });
    } catch (e) {
      console.error("[Summarizer] session set:", e);
    }
  }
  async function getTabState(tabId) {
    if (tabId == null) return null;
    const all = await getAllTabStates();
    return all[tabId] || null;
  }
  async function setTabState(tabId, state) {
    if (tabId == null) return;
    const all = await getAllTabStates();
    all[tabId] = { ...state, tabId };
    await setAllTabStates(all);
  }
  async function patchTabState(tabId, patch) {
    if (tabId == null) return null;
    const all = await getAllTabStates();
    const next = { ...all[tabId] || {}, ...patch, tabId };
    all[tabId] = next;
    await setAllTabStates(all);
    return next;
  }
  async function deleteTabState(tabId) {
    const all = await getAllTabStates();
    if (tabId in all) {
      delete all[tabId];
      await setAllTabStates(all);
    }
  }
  async function getActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab || null;
    } catch (_) {
      return null;
    }
  }
  function broadcast(state) {
    try {
      chrome.runtime.sendMessage({ type: MSG.SUMMARY_READY, state }, () => {
        void chrome.runtime?.lastError;
      });
    } catch (_) {
    }
  }
  async function broadcastIfActive(tabId, state) {
    const active = await getActiveTab();
    if (active?.id === tabId) broadcast({ ...state, tabId });
  }
  function classify(url) {
    if (!url || !/^https?:\/\//i.test(url)) return "unsupported";
    if (isWatchUrl(url)) return "youtube";
    if (/^https?:\/\/(?:[^/]*\.)?youtube\.com\//i.test(url) || /^https?:\/\/youtu\.be\//i.test(url))
      return "youtube-other";
    return "page";
  }
  async function ensureTabState(tab) {
    if (!tab || tab.id == null) return;
    const tabId = tab.id;
    const url = tab.url || "";
    const kind = classify(url);
    const cached = await getTabState(tabId);
    if (cached && cached.url === url && cached.status && cached.status !== "loading-page") {
      broadcast({ ...cached, tabId });
      return;
    }
    if (kind === "page") {
      const loading = { tabId, url, kind, status: "loading-page", title: tab.title || url };
      await setTabState(tabId, loading);
      await broadcastIfActive(tabId, loading);
      if (tab.status && tab.status !== "complete") return;
      const extracted = await extractPage(tabId);
      let next;
      if (extracted && extracted.text && extracted.text.trim().length > 20) {
        next = {
          tabId,
          url,
          kind: "page",
          status: "page_ready",
          title: extracted.title || tab.title || url,
          pageText: clampPageText(extracted.text),
          sourceKey: "page:" + url,
          chat: null
        };
      } else {
        next = {
          tabId,
          url,
          kind: "page",
          status: "error",
          title: tab.title || url,
          error: "Couldn't read this page's text to summarize it."
        };
      }
      await setTabState(tabId, next);
      await broadcastIfActive(tabId, next);
      return;
    }
    if (kind === "youtube") {
      const placeholder = cached?.kind === "youtube" ? cached : { tabId, url, kind, status: "idle", title: tab.title || "" };
      broadcast({ ...placeholder, tabId });
      return;
    }
    const hint = kind === "youtube-other" ? "Open a YouTube video, or switch to an article to summarize it." : "This page can't be summarized. Open a webpage or a YouTube video.";
    const idle = { tabId, url, kind, status: "idle", title: tab.title || "", hint };
    await setTabState(tabId, idle);
    await broadcastIfActive(tabId, idle);
  }
  async function extractPage(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPageContent
      });
      return results?.[0]?.result || null;
    } catch (e) {
      console.debug("[Summarizer] page extract failed:", e?.message || e);
      return null;
    }
  }
  async function syncActiveTab() {
    const tab = await getActiveTab();
    if (tab) await ensureTabState(tab);
  }
  chrome.tabs?.onActivated?.addListener(() => {
    syncActiveTab();
  });
  chrome.windows?.onFocusChanged?.addListener(() => {
    syncActiveTab();
  });
  chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => {
    getActiveTab().then((active) => {
      if (!active || active.id !== tabId) {
        if (info.url) deleteTabState(tabId);
        return;
      }
      if (info.url || info.status === "complete") ensureTabState(tab);
    });
  });
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    deleteTabState(tabId);
  });
  chrome.commands?.onCommand?.addListener((command) => {
    if (command === "open_side_panel") openSidePanelForActiveTab();
  });
  async function openSidePanelForActiveTab() {
    const tab = await getActiveTab();
    try {
      const opts = tab?.windowId != null ? { windowId: tab.windowId } : tab?.id != null ? { tabId: tab.id } : {};
      await chrome.sidePanel?.open?.(opts);
      if (tab) ensureTabState(tab);
    } catch (e) {
      console.debug("[Summarizer] open via shortcut failed:", e?.message || e);
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
        handlePublish(message.payload, sender);
        sendResponse?.({ ok: true });
        return false;
      case MSG.SAVE_CHAT:
        handleSaveChat(message, sender);
        sendResponse?.({ ok: true });
        return false;
      case MSG.OPEN_SIDE_PANEL:
        openSidePanel(sender).then((opened) => sendResponse({ ok: true, opened }));
        return true;
      // async response
      case MSG.SUMMARY_STATE_REQUEST:
        handleStateRequest(sendResponse);
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
  async function handlePublish(payload, sender) {
    const tabId = sender?.tab?.id;
    if (tabId == null || !payload) return;
    const prev = await getTabState(tabId);
    const next = { ...prev || {}, ...payload, tabId, kind: "youtube" };
    if (payload.videoId && prev?.videoId && payload.videoId !== prev.videoId) {
      next.chat = null;
    }
    if (payload.videoId) next.sourceKey = "yt:" + payload.videoId;
    await setTabState(tabId, next);
    await broadcastIfActive(tabId, next);
  }
  async function handleSaveChat(message, sender) {
    const tabId = message.tabId ?? sender?.tab?.id ?? (await getActiveTab())?.id;
    if (tabId == null) return;
    await patchTabState(tabId, { chat: message.chat || null });
  }
  async function handleStateRequest(sendResponse) {
    const tab = await getActiveTab();
    if (!tab) {
      sendResponse({ ok: true, state: null });
      return;
    }
    const state = await getTabState(tab.id);
    sendResponse({ ok: true, state: state ? { ...state, tabId: tab.id } : null });
    ensureTabState(tab);
  }
  async function handleGenerate(message, sender, sendResponse) {
    try {
      if (message.videoUrl && !YOUTUBE_DOMAIN_RE.test(message.videoUrl)) {
        sendResponse({ ok: false, error: "Invalid video URL." });
        return;
      }
      const provider = await getProvider();
      if (!provider.apiKey) {
        sendResponse({ ok: false, error: missingKeyError(provider) });
        return;
      }
      const mode = message.transcript?.trim() ? "transcript" : "video";
      if (mode === "video" && provider.id === "openrouter") {
        sendResponse({
          ok: false,
          error: "OpenRouter needs captions for YouTube videos. Switch to Gemini to use the video fallback."
        });
        return;
      }
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
        finalText = await streamWithProvider(provider, {
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
        sendResponse({ ok: false, error: `${provider.name} returned no summary (response may have been blocked).` });
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
      const provider = await getProvider();
      if (!provider.apiKey) {
        sendResponse({ ok: false, error: missingKeyError(provider) });
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
        const finalText = await streamWithProvider(provider, {
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
      const active = await getActiveTab();
      if (sender?.tab?.id != null && active && active.id !== sender.tab.id) {
        return false;
      }
      const opts = {};
      if (sender?.tab?.windowId != null) opts.windowId = sender.tab.windowId;
      else if (sender?.tab?.id != null) opts.tabId = sender.tab.id;
      await chrome.sidePanel?.open?.(opts);
      return true;
    } catch (e) {
      console.debug("[Summarizer] sidePanel.open skipped:", e?.message || e);
      return false;
    }
  }
})();
