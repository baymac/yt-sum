(() => {
  // src/lib/transcript.js
  function extractPlayerResponse(html) {
    if (!html) return null;
    const marker = "ytInitialPlayerResponse";
    let from = 0;
    for (; ; ) {
      const idx = html.indexOf(marker, from);
      if (idx === -1) return null;
      from = idx + marker.length;
      const eq = html.indexOf("=", idx);
      if (eq === -1) return null;
      const braceStart = html.indexOf("{", eq);
      if (braceStart === -1) return null;
      if (braceStart - eq > 8) continue;
      const json = sliceBalanced(html, braceStart);
      if (json) {
        try {
          return JSON.parse(json);
        } catch (_) {
        }
      }
    }
  }
  var SLICE_SIZE_LIMIT = 2e6;
  function sliceBalanced(s, start) {
    if (s.length - start > SLICE_SIZE_LIMIT) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = !inStr;
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  }
  function pickCaptionTrack(tracks, preferredLangs = ["en"]) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const isAsr = (t) => t.kind === "asr";
    for (const lang of preferredLangs) {
      const manual = tracks.find((t) => t.languageCode === lang && !isAsr(t));
      if (manual) return { track: manual, translate: false };
      const asr = tracks.find((t) => t.languageCode === lang && isAsr(t));
      if (asr) return { track: asr, translate: false };
    }
    const base = tracks.find((t) => !isAsr(t)) || tracks[0];
    const wantLang = preferredLangs[0];
    if (base.languageCode !== wantLang && base.isTranslatable) {
      return { track: base, translate: true, tlang: wantLang };
    }
    return { track: base, translate: false };
  }
  function isPotGated(baseUrl) {
    if (!baseUrl) return false;
    try {
      const u = new URL(baseUrl, "https://www.youtube.com");
      const exp = u.searchParams.get("exp") || "";
      return exp.split(",").includes("xpe");
    } catch (_) {
      return /[?&]exp=(?:[^&]*,)?xpe(?:,|&|$)/.test(baseUrl);
    }
  }
  function buildTimedtextUrl(baseUrl, { fmt = "json3", tlang } = {}) {
    const u = new URL(baseUrl, "https://www.youtube.com");
    if (fmt) u.searchParams.set("fmt", fmt);
    if (tlang) u.searchParams.set("tlang", tlang);
    return u.toString();
  }
  function parseJson3(data) {
    if (!data || !Array.isArray(data.events)) return "";
    const text = data.events.filter((e) => Array.isArray(e.segs)).map((e) => e.segs.map((s) => s.utf8 || "").join("")).join(" ");
    return text.replace(/\s+/g, " ").trim();
  }
  function describeTranscriptFailure(reason) {
    switch (reason) {
      case "no-captions":
        return "This video has no captions.";
      case "pot-gated":
      case "pot-blocked":
        return "YouTube blocked direct caption access for this video.";
      case "not-playable":
        return "This video is restricted (sign-in, age, or members-only).";
      case "no-player-response":
        return "Could not read this video's data from YouTube.";
      default:
        return "Could not fetch the transcript.";
    }
  }
  async function fetchTranscript(videoId, opts = {}) {
    const f = opts.fetchImpl || globalThis.fetch;
    const preferredLangs = opts.preferredLangs || ["en"];
    let html;
    try {
      const res = await f(
        `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`,
        { credentials: "include" }
      );
      html = await res.text();
    } catch (e) {
      return { ok: false, reason: "fetch-failed", detail: String(e) };
    }
    const pr = extractPlayerResponse(html);
    if (!pr) return { ok: false, reason: "no-player-response" };
    const title = pr?.videoDetails?.title;
    const status = pr?.playabilityStatus?.status;
    if (status && status !== "OK") {
      return { ok: false, reason: "not-playable", status, title };
    }
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const picked = pickCaptionTrack(tracks, preferredLangs);
    if (!picked || !picked.track.baseUrl) return { ok: false, reason: "no-captions", title };
    if (isPotGated(picked.track.baseUrl)) {
      return { ok: false, reason: "pot-gated", title };
    }
    const url = buildTimedtextUrl(picked.track.baseUrl, {
      fmt: "json3",
      tlang: picked.translate ? picked.tlang : void 0
    });
    let body;
    try {
      const res = await f(url, { credentials: "include" });
      body = await res.text();
    } catch (e) {
      return { ok: false, reason: "timedtext-failed", detail: String(e), title };
    }
    if (!body || !body.trim()) return { ok: false, reason: "pot-blocked", title };
    let json;
    try {
      json = JSON.parse(body);
    } catch (_) {
      return { ok: false, reason: "parse-failed", title };
    }
    const text = parseJson3(json);
    if (!text) return { ok: false, reason: "empty-transcript", title };
    return {
      ok: true,
      text,
      title,
      lang: picked.track.languageCode,
      source: "transcript"
    };
  }

  // src/lib/youtube-dom.js
  var VIDEO_CONTAINER_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-rich-grid-media"
  ];
  var DURATION_RE = /^\d+:\d+(?::\d+)?$/;
  function extractVideoId(url) {
    if (!url) return null;
    const path = url.match(/(?:youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/);
    if (path) return path[1];
    const query = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    return query ? query[1] : null;
  }
  function getWatchVideoId(url) {
    try {
      const u = new URL(url, "https://www.youtube.com");
      if (u.pathname !== "/watch") return null;
      const v = u.searchParams.get("v");
      return v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
    } catch (_) {
      return null;
    }
  }
  var looksLikeTitle = (s) => !!s && !DURATION_RE.test(s.trim());
  function getVideoTitle(container, videoLink) {
    const clean = (s) => (s || "").replace(/\s+\d+:\d+(?::\d+)?\s*$/, "").trim();
    const titleEl = container?.querySelector?.(
      "#video-title, a#video-title-link, #video-title-link"
    );
    if (titleEl) {
      const t = titleEl.textContent?.trim() || titleEl.getAttribute?.("aria-label") || titleEl.getAttribute?.("title");
      if (looksLikeTitle(t)) return clean(t);
    }
    const h3 = container?.querySelector?.('h3 a[href*="/watch?v="]');
    if (h3) {
      const t = h3.textContent?.trim() || h3.getAttribute?.("aria-label");
      if (looksLikeTitle(t)) return clean(t);
    }
    const aria = videoLink?.getAttribute?.("aria-label");
    if (looksLikeTitle(aria)) {
      const byMatch = aria.match(/^(.+?)\s+by\s+/);
      return clean(byMatch ? byMatch[1] : aria);
    }
    const titleAttr = videoLink?.title || videoLink?.getAttribute?.("title");
    if (looksLikeTitle(titleAttr)) return clean(titleAttr);
    return "";
  }
  function findInsertionPoint(container) {
    const meta = container.querySelector("#metadata-line") || container.querySelector("#metadata") || container.querySelector("#meta") || container.querySelector("ytd-video-meta-block");
    if (meta?.parentNode) return { parent: meta.parentNode, before: meta.nextSibling };
    const detailsEl = container.querySelector("#details");
    if (detailsEl) return { parent: detailsEl, before: null };
    const details = container.querySelector("#dismissible");
    if (details?.firstElementChild)
      return { parent: details, before: details.firstElementChild };
    const thumb = container.querySelector("ytd-thumbnail, #thumbnail, a#thumbnail");
    if (thumb?.parentNode) return { parent: thumb.parentNode, before: thumb.nextSibling };
    const title = container.querySelector("#video-title, #video-title-link, h3");
    if (title?.parentNode) return { parent: title.parentNode, before: title.nextSibling };
    return { parent: container, before: null };
  }
  function insertButton(container, button) {
    try {
      const spot = findInsertionPoint(container);
      if (!spot) return false;
      spot.parent.insertBefore(button, spot.before);
      return true;
    } catch (_) {
      return false;
    }
  }

  // src/lib/markdown.js
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }
  function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function sanitizeUrl(url) {
    if (!url) return "#";
    const trimmed = String(url).trim();
    if (!/^https?:\/\//i.test(trimmed)) return "#";
    if (/["'`<>\s -]/.test(trimmed)) return "#";
    return trimmed;
  }
  function processInlineMarkdown(str) {
    str = escapeHtml(str);
    const links = [];
    str = str.replace(
      /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g,
      (_m, text, url) => {
        const href = escapeAttr(sanitizeUrl(url));
        links.push(
          `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
        );
        return `@@YTSUMLINK${links.length - 1}@@`;
      }
    );
    str = str.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    str = str.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    str = str.replace(/`([^`]+)`/g, "<code>$1</code>");
    str = str.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>");
    str = str.replace(/(?<!_)_([^_\n]+?)_(?!_)/g, "<em>$1</em>");
    str = str.replace(/@@YTSUMLINK(\d+)@@/g, (_m, i) => links[Number(i)]);
    return str;
  }
  function formatSummary(text) {
    if (text == null || text === "") return "";
    const lines = String(text).split("\n");
    let html = "";
    let inList = false;
    let listType = null;
    let inCode = false;
    let codeBuffer = [];
    const closeList = () => {
      if (inList) {
        html += `</${listType}>`;
        inList = false;
        listType = null;
      }
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        if (inCode) {
          html += `<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`;
          codeBuffer = [];
          inCode = false;
        } else {
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeBuffer.push(line);
        continue;
      }
      if (!trimmed) {
        closeList();
        continue;
      }
      if (/^#{1,6}\s/.test(trimmed)) {
        closeList();
        const level = Math.min(trimmed.match(/^#+/)[0].length, 6);
        const content = trimmed.replace(/^#+\s*/, "");
        html += `<h${level}>${processInlineMarkdown(content)}</h${level}>`;
        continue;
      }
      if (/^[-*]\s/.test(trimmed)) {
        if (!inList || listType !== "ul") {
          closeList();
          html += "<ul>";
          inList = true;
          listType = "ul";
        }
        html += `<li>${processInlineMarkdown(trimmed.replace(/^[-*]\s+/, ""))}</li>`;
        continue;
      }
      if (/^\d+\.\s/.test(trimmed)) {
        if (!inList || listType !== "ol") {
          closeList();
          html += "<ol>";
          inList = true;
          listType = "ol";
        }
        html += `<li>${processInlineMarkdown(trimmed.replace(/^\d+\.\s+/, ""))}</li>`;
        continue;
      }
      closeList();
      html += `<p>${processInlineMarkdown(trimmed)}</p>`;
    }
    if (inCode) html += `<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`;
    closeList();
    return html || `<p>${processInlineMarkdown(String(text))}</p>`;
  }

  // src/lib/modal.js
  var MODAL_ID = "yt-sum-summary-modal";
  var escapeHandler = null;
  var activeToken = 0;
  function lockScroll() {
    const scrollY = window.scrollY;
    document.body.classList.add("yt-sum-modal-open");
    document.body.style.top = `-${scrollY}px`;
    document.body.dataset.ytSumScrollY = String(scrollY);
  }
  function unlockScroll() {
    document.body.classList.remove("yt-sum-modal-open");
    const y = parseInt(document.body.dataset.ytSumScrollY || "0", 10);
    document.body.style.top = "";
    delete document.body.dataset.ytSumScrollY;
    window.scrollTo(0, y);
  }
  function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    if (escapeHandler) {
      document.removeEventListener("keydown", escapeHandler);
      escapeHandler = null;
    }
    unlockScroll();
    modal.remove();
  }
  function bodyHtml(inner) {
    return `
    <div class="yt-sum-modal-content">
      <div class="yt-sum-modal-header">
        <h3>${escapeHtml(currentTitle)}</h3>
        <button class="yt-sum-close-btn" aria-label="Close">\xD7</button>
      </div>
      <div class="yt-sum-modal-body">${inner}</div>
    </div>`;
  }
  var currentTitle = "";
  var LOADING_INNER = `
  <div class="yt-sum-loading-container">
    <div class="yt-sum-streaming-loader">
      <span class="yt-sum-bounce-dot"></span>
      <span class="yt-sum-bounce-dot"></span>
      <span class="yt-sum-bounce-dot"></span>
    </div>
    <p class="yt-sum-loading-text">Reading the transcript and summarizing\u2026</p>
  </div>`;
  function openLoadingModal(title, { darkMode = false } = {}) {
    closeModal();
    activeToken += 1;
    currentTitle = title || "Summary";
    const modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.className = darkMode ? "yt-sum-modal dark-mode" : "yt-sum-modal";
    modal.innerHTML = bodyHtml(LOADING_INNER);
    document.body.appendChild(modal);
    lockScroll();
    modal.querySelector(".yt-sum-close-btn").addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
    escapeHandler = (e) => {
      if (e.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", escapeHandler);
    return activeToken;
  }
  function setBody(html, token) {
    if (token != null && token !== activeToken) return;
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    const body = modal.querySelector(".yt-sum-modal-body");
    if (body) body.innerHTML = html;
  }
  function showStreamingText(text, token) {
    if (token != null && token !== activeToken) return;
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    const body = modal.querySelector(".yt-sum-modal-body");
    if (!body) return;
    body.innerHTML = formatSummary(text) + '<span class="yt-sum-cursor" aria-hidden="true">\u258B</span>';
  }
  function showSummary(text, { mode, token } = {}) {
    const note = mode === "video" ? '<p class="yt-sum-source-note">Captions were unavailable, so this was generated by Gemini watching the video.</p>' : "";
    setBody(note + formatSummary(text), token);
  }
  function showError(message, token) {
    setBody(`<div class="yt-sum-error">${escapeHtml(message)}</div>`, token);
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
    SUMMARY_PROGRESS: "SUMMARY_PROGRESS"
  };

  // src/content.js
  var BTN_CLASS = "yt-sum-summarize-btn";
  var WATCH_BTN_ID = "yt-sum-watch-btn";
  var LOADING_CLASS = "yt-sum-loading";
  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          void chrome.runtime?.lastError;
          resolve(resp);
        });
      } catch (_) {
        resolve(void 0);
      }
    });
  }
  async function summarizeVideo({ videoId, title, target }) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const sidebar = target === "sidebar";
    let modalToken = null;
    let panelOpened = false;
    if (sidebar) {
      publish({ status: "loading", videoId, title });
      const opened = await sendMessage({ type: MSG.OPEN_SIDE_PANEL });
      panelOpened = opened?.opened === true;
    } else {
      const { darkMode } = await storageGet(["darkMode"]);
      modalToken = openLoadingModal(title || "Summary", { darkMode: !!darkMode });
    }
    const tr = await fetchTranscript(videoId);
    const resolvedTitle = title || tr.title || "Summary";
    const ctx = { modalToken, videoId, resolvedTitle, panelOpened };
    if (!tr.ok && tr.reason === "not-playable") {
      emit(sidebar, { ok: false, error: describeTranscriptFailure(tr.reason) }, ctx);
      return;
    }
    const transcript = tr.ok ? tr.text : null;
    const resp = await sendMessage({
      type: MSG.GENERATE_SUMMARY,
      videoId,
      videoUrl,
      title: resolvedTitle,
      transcript,
      target: sidebar ? "sidebar" : "modal",
      token: modalToken
    });
    emit(
      sidebar,
      resp?.ok ? { ok: true, text: resp.text, mode: resp.mode } : { ok: false, error: resp?.error || "Failed to summarize. Please try again." },
      ctx
    );
  }
  function emit(sidebar, result, ctx) {
    if (sidebar) {
      if (result.ok) {
        publish({ status: "done", videoId: ctx.videoId, title: ctx.resolvedTitle, text: result.text, mode: result.mode });
      } else {
        publish({ status: "error", videoId: ctx.videoId, title: ctx.resolvedTitle, error: result.error });
      }
      if (!ctx.panelOpened) {
        showToast("Summary ready \u2014 click the extension icon to open the sidebar.");
      }
    } else if (result.ok) {
      showSummary(result.text, { mode: result.mode, token: ctx.modalToken });
    } else {
      showError(result.error, ctx.modalToken);
    }
  }
  function publish(payload) {
    sendMessage({ type: MSG.PUBLISH_SUMMARY, payload });
  }
  function showToast(message) {
    document.getElementById("yt-sum-toast")?.remove();
    const toast = document.createElement("div");
    toast.id = "yt-sum-toast";
    toast.className = "yt-sum-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add("yt-sum-toast-hide"), 5e3);
    setTimeout(() => toast.remove(), 5400);
  }
  function makeButton({ label, title, onClick }) {
    const button = document.createElement("button");
    button.className = BTN_CLASS;
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(button);
    });
    return button;
  }
  async function withButtonLoading(button, fn) {
    const original = button.textContent;
    button.classList.add(LOADING_CLASS);
    button.disabled = true;
    button.textContent = "\u23F3 Summarizing\u2026";
    try {
      await fn();
    } finally {
      button.classList.remove(LOADING_CLASS);
      button.disabled = false;
      button.textContent = original;
    }
  }
  function addFeedButtons() {
    let added = 0;
    for (const selector of VIDEO_CONTAINER_SELECTORS) {
      const isCompact = selector === "ytd-compact-video-renderer";
      for (const container of document.querySelectorAll(selector)) {
        if (container.querySelector(`.${BTN_CLASS}`)) continue;
        const videoLink = container.querySelector('a[href*="/watch?v="]');
        if (!videoLink) continue;
        const videoId = extractVideoId(videoLink.href || videoLink.getAttribute("href"));
        if (!videoId) continue;
        const title = getVideoTitle(container, videoLink) || "Untitled Video";
        const button = makeButton({
          label: isCompact ? "\u{1F4DD} Summarize" : "\u{1F4DD} Summarize",
          title: "Get an AI summary of this video",
          onClick: (btn) => withButtonLoading(
            btn,
            () => summarizeVideo({ videoId, title, target: "modal" })
          )
        });
        if (isCompact) button.classList.add("yt-sum-compact-btn");
        if (insertButton(container, button)) added++;
      }
    }
    return added;
  }
  function addWatchButton() {
    const videoId = getWatchVideoId(location.href);
    const existing = document.getElementById(WATCH_BTN_ID);
    if (!videoId) {
      existing?.remove();
      return;
    }
    if (existing) {
      if (existing.dataset.videoId === videoId) return;
      existing.remove();
    }
    const titleEl = document.querySelector(
      "ytd-watch-metadata #title, #above-the-fold #title, h1.ytd-watch-metadata"
    );
    if (!titleEl) return;
    const title = document.querySelector("ytd-watch-metadata #title yt-formatted-string, h1.ytd-watch-metadata")?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();
    const button = makeButton({
      label: "\u{1F4DD} Summarize in sidebar",
      title: "Summarize this video in the side panel",
      onClick: (btn) => withButtonLoading(
        btn,
        () => summarizeVideo({ videoId, title, target: "sidebar" })
      )
    });
    button.id = WATCH_BTN_ID;
    button.dataset.videoId = videoId;
    button.classList.add("yt-sum-watch-btn");
    titleEl.appendChild(button);
  }
  function scanAndInject() {
    try {
      addFeedButtons();
      addWatchButton();
    } catch (e) {
      console.error("[YT Summarizer] inject error:", e);
    }
  }
  function init() {
    const start = () => setTimeout(scanAndInject, 800);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
    let t;
    const observer = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(scanAndInject, 500);
    });
    setTimeout(() => {
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    }, 1500);
    document.addEventListener("yt-navigate-finish", () => setTimeout(scanAndInject, 800));
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(scanAndInject, 1e3);
      }
    }, 1e3);
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === MSG.SUMMARIZE_IN_SIDEBAR) {
        const videoId = message.videoId || getWatchVideoId(location.href);
        if (videoId) {
          const title = document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();
          summarizeVideo({ videoId, title, target: "sidebar" });
        }
      } else if (message?.type === MSG.SUMMARY_PROGRESS) {
        if (message.target === "modal") {
          showStreamingText(message.text, message.token);
        } else if (message.target === "sidebar") {
          publish({ status: "streaming", text: message.text });
        }
      }
      return false;
    });
  }
  console.log("[YT Summarizer] content script loaded");
  init();
})();
