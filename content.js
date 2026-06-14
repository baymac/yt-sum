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
    const end = Math.min(s.length, start + SLICE_SIZE_LIMIT);
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < end; i++) {
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
  var ORIGIN = "https://www.youtube.com";
  var INNERTUBE_PLAYER_CLIENTS = [
    { clientName: "WEB_CREATOR", clientNum: 62, version: "1.20260114.05.00" },
    { clientName: "TVHTML5", clientNum: 7, version: "7.20260114.12.00" }
  ];
  function parseCookies(str) {
    const out = {};
    for (const part of (str || "").split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function makeSidAuthorization(cookieStr, now = Date.now()) {
    const c = parseCookies(cookieStr);
    const sapisid = c.SAPISID || c["__Secure-3PAPISID"];
    const ts = Math.floor(now / 1e3).toString();
    const parts = [];
    for (const [scheme, sid] of [
      ["SAPISIDHASH", sapisid],
      ["SAPISID1PHASH", c["__Secure-1PAPISID"]],
      ["SAPISID3PHASH", c["__Secure-3PAPISID"]]
    ]) {
      if (!sid) continue;
      parts.push(`${scheme} ${ts}_${await sha1Hex(`${ts} ${sid} ${ORIGIN}`)}`);
    }
    return parts.length ? parts.join(" ") : null;
  }
  function parseInnertubeConfig(html) {
    if (!html) return null;
    const apiKey = html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/)?.[1];
    const visitorData = html.match(/"visitorData":\s*"([^"]+)"/)?.[1] || html.match(/"VISITOR_DATA":\s*"([^"]+)"/)?.[1] || void 0;
    if (!apiKey) return null;
    return { apiKey, visitorData };
  }
  async function fetchInnertubeTranscript({ f, videoId, html, cookieStr, preferredLangs, dbg }) {
    const cfg = parseInnertubeConfig(html);
    if (!cfg) {
      dbg("innertube: no INNERTUBE_API_KEY in page \u2014 skipping");
      return null;
    }
    const auth = await makeSidAuthorization(cookieStr).catch(() => null);
    if (!auth) {
      dbg("innertube: no SAPISID cookie \u2014 not signed in, can't use web_creator/tv");
      return null;
    }
    dbg("innertube: auth header built, visitorData:", cfg.visitorData ? "yes" : "no");
    for (const client of INNERTUBE_PLAYER_CLIENTS) {
      try {
        const text = await fetchPlayerCaptions({ f, videoId, cfg, auth, client, preferredLangs, dbg });
        if (text) return text;
      } catch (e) {
        dbg(`innertube ${client.clientName}: failed \u2014`, String(e));
      }
    }
    return null;
  }
  async function fetchPlayerCaptions({ f, videoId, cfg, auth, client, preferredLangs, dbg }) {
    const res = await f(`https://www.youtube.com/youtubei/v1/player?key=${cfg.apiKey}&prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
        "X-Origin": ORIGIN,
        "X-Goog-AuthUser": "0",
        "X-Youtube-Client-Name": String(client.clientNum),
        "X-Youtube-Client-Version": client.version,
        ...cfg.visitorData ? { "X-Goog-Visitor-Id": cfg.visitorData } : {}
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: client.clientName,
            clientVersion: client.version,
            hl: "en",
            ...cfg.visitorData ? { visitorData: cfg.visitorData } : {}
          }
        },
        videoId
      })
    });
    const pr = JSON.parse(await res.text());
    const status = pr?.playabilityStatus?.status;
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    dbg(`innertube ${client.clientName}: status`, status, "caption tracks", tracks?.length ?? 0);
    const picked = pickCaptionTrack(tracks, preferredLangs);
    if (!picked?.track?.baseUrl) return null;
    const gated = isPotGated(picked.track.baseUrl);
    dbg(`innertube ${client.clientName}: caption baseUrl gated?`, gated);
    const url = buildTimedtextUrl(picked.track.baseUrl, {
      fmt: "json3",
      tlang: picked.translate ? picked.tlang : void 0
    });
    const tr = await f(url, { credentials: "include" });
    const body = await tr.text();
    dbg(`innertube ${client.clientName}: timedtext status`, tr.status, "body length", body.length);
    if (!body || !body.trim()) return null;
    const text = parseJson3(JSON.parse(body));
    return text || null;
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
    const cookieStr = opts.cookieStr ?? (typeof document !== "undefined" ? document.cookie : "");
    const dbg = (...a) => console.log("[YT-SUM transcript]", ...a);
    dbg("start", { videoId, preferredLangs });
    let html;
    try {
      const res = await f(
        `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`,
        { credentials: "include" }
      );
      dbg("watch-page fetch", res.status, res.url, "html length will follow");
      html = await res.text();
      dbg("watch-page html length:", html.length, "bytes");
    } catch (e) {
      dbg("FAIL fetch-failed", e);
      return { ok: false, reason: "fetch-failed", detail: String(e) };
    }
    const markerIdx = html.indexOf("ytInitialPlayerResponse");
    dbg("ytInitialPlayerResponse marker at index:", markerIdx, "(of", html.length, ")");
    const pr = extractPlayerResponse(html);
    dbg("extractPlayerResponse result:", pr ? "OK" : "NULL");
    if (!pr) {
      dbg("FAIL no-player-response \u2014 marker was at", markerIdx, "page length", html.length);
      return { ok: false, reason: "no-player-response" };
    }
    const title = pr?.videoDetails?.title;
    const status = pr?.playabilityStatus?.status;
    dbg("playabilityStatus:", status, "title:", title);
    if (status && status !== "OK") {
      dbg("FAIL not-playable, status:", status);
      return { ok: false, reason: "not-playable", status, title };
    }
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    dbg("caption tracks found:", tracks?.length ?? 0, tracks?.map((t) => `${t.languageCode}(${t.kind || "manual"})`));
    const picked = pickCaptionTrack(tracks, preferredLangs);
    dbg("pickCaptionTrack result:", picked ? { lang: picked.track.languageCode, kind: picked.track.kind, translate: picked.translate } : "NULL");
    if (!picked || !picked.track.baseUrl) {
      dbg("FAIL no-captions");
      return { ok: false, reason: "no-captions", title };
    }
    const potGated = isPotGated(picked.track.baseUrl);
    dbg("isPotGated:", potGated, "baseUrl (first 120):", picked.track.baseUrl.slice(0, 120));
    const url = buildTimedtextUrl(picked.track.baseUrl, {
      fmt: "json3",
      tlang: picked.translate ? picked.tlang : void 0
    });
    dbg("fetching timedtext url (first 120):", url.slice(0, 120));
    let body;
    try {
      const res = await f(url, { credentials: "include" });
      dbg("timedtext fetch status:", res.status);
      body = await res.text();
      dbg("timedtext body length:", body.length, "first 200 chars:", body.slice(0, 200));
    } catch (e) {
      dbg("FAIL timedtext-failed", e);
      return { ok: false, reason: "timedtext-failed", detail: String(e), title };
    }
    if ((!body || !body.trim()) && potGated) {
      const simpleLang = picked.track.languageCode;
      const simpleUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(simpleLang)}&fmt=json3`;
      dbg("pot-blocked \u2014 trying simplified timedtext fallback:", simpleUrl);
      try {
        const sr = await f(simpleUrl, { credentials: "include" });
        const sb = await sr.text();
        dbg("simplified timedtext status:", sr.status, "body length:", sb.length, "first 200:", sb.slice(0, 200));
        if (sb && sb.trim()) body = sb;
      } catch (e) {
        dbg("simplified timedtext fallback threw:", e);
      }
    }
    if (!body || !body.trim()) {
      dbg("timedtext exhausted \u2014 trying InnerTube player (web_creator/tv) fallback");
      const itText = await fetchInnertubeTranscript({ f, videoId, html, cookieStr, preferredLangs, dbg });
      if (itText) {
        dbg("SUCCESS via InnerTube, text length:", itText.length);
        return { ok: true, text: itText, title, lang: picked.track.languageCode, source: "innertube" };
      }
    }
    if (!body || !body.trim()) {
      dbg("FAIL pot-blocked \u2014 empty body (all attempts exhausted)");
      return { ok: false, reason: "pot-blocked", title };
    }
    let json;
    try {
      json = JSON.parse(body);
      dbg("JSON parse OK, events count:", json?.events?.length);
    } catch (e) {
      dbg("FAIL parse-failed", e, "body snippet:", body.slice(0, 200));
      return { ok: false, reason: "parse-failed", title };
    }
    const text = parseJson3(json);
    dbg("parseJson3 text length:", text.length, "snippet:", text.slice(0, 100));
    if (!text) {
      dbg("FAIL empty-transcript");
      return { ok: false, reason: "empty-transcript", title };
    }
    dbg("SUCCESS lang:", picked.track.languageCode, "text length:", text.length);
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
    "ytd-rich-grid-media",
    "yt-lockup-view-model"
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
      "#video-title, a#video-title-link, #video-title-link, a.ytLockupMetadataViewModelHeadingReset, .ytLockupMetadataViewModelHeadingReset"
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
    const lockupMeta = container.querySelector("yt-content-metadata-view-model");
    if (lockupMeta?.parentNode) return { parent: lockupMeta.parentNode, before: lockupMeta.nextSibling };
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

  // src/lib/messages.js
  var MSG = {
    GENERATE_SUMMARY: "GENERATE_SUMMARY",
    PUBLISH_SUMMARY: "PUBLISH_SUMMARY",
    SUMMARY_READY: "SUMMARY_READY",
    SUMMARY_STATE_REQUEST: "SUMMARY_STATE_REQUEST",
    OPEN_SIDE_PANEL: "OPEN_SIDE_PANEL",
    SUMMARIZE_IN_SIDEBAR: "SUMMARIZE_IN_SIDEBAR",
    SUMMARY_PROGRESS: "SUMMARY_PROGRESS",
    CANCEL_SUMMARY: "CANCEL_SUMMARY"
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
  var currentSidebarJob = null;
  function summarizeVideo({ videoId, title }) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let settled = false;
    const cancel = ({ quiet = false } = {}) => {
      if (settled) return;
      settled = true;
      sendMessage({ type: MSG.CANCEL_SUMMARY, videoId });
      if (!quiet) publish({ status: "idle", videoId, title });
    };
    const job = { videoId, cancel };
    if (currentSidebarJob) currentSidebarJob.cancel({ quiet: true });
    currentSidebarJob = job;
    const promise = (async () => {
      publish({ status: "loading", videoId, title });
      const opened = await sendMessage({ type: MSG.OPEN_SIDE_PANEL });
      const panelOpened = opened?.opened === true;
      if (settled) return;
      const tr = await fetchTranscript(videoId);
      if (settled) return;
      const resolvedTitle = title || tr.title || "Summary";
      const ctx = { videoId, resolvedTitle, panelOpened };
      if (!tr.ok && tr.reason === "not-playable") {
        settled = true;
        emit({ ok: false, error: describeTranscriptFailure(tr.reason) }, ctx);
        return;
      }
      const transcript = tr.ok ? tr.text : null;
      if (!transcript) {
        publish({ status: "streaming", text: "Captions were unavailable \u2014 Gemini is watching the video\u2026" });
      }
      const resp = await sendMessage({
        type: MSG.GENERATE_SUMMARY,
        videoId,
        videoUrl,
        title: resolvedTitle,
        transcript,
        target: "sidebar"
      });
      if (settled || resp?.cancelled) return;
      settled = true;
      emit(
        resp?.ok ? { ok: true, text: resp.text, mode: resp.mode } : { ok: false, error: resp?.error || "Failed to summarize. Please try again." },
        ctx
      );
    })();
    promise.finally(() => {
      if (currentSidebarJob === job) currentSidebarJob = null;
    });
    return { promise, cancel };
  }
  function emit(result, ctx) {
    if (result.ok) {
      publish({ status: "done", videoId: ctx.videoId, title: ctx.resolvedTitle, text: result.text, mode: result.mode });
    } else {
      publish({ status: "error", videoId: ctx.videoId, title: ctx.resolvedTitle, error: result.error });
    }
    if (!ctx.panelOpened) {
      showToast("Summary ready \u2014 click the extension icon to open the sidebar.");
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
  function makeButton({ label, title, run }) {
    const button = document.createElement("button");
    button.className = BTN_CLASS;
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (button._ytSumCancel) {
        button._ytSumCancel();
        return;
      }
      button.classList.add(LOADING_CLASS);
      button.textContent = "\u2715 Cancel";
      const job = run();
      button._ytSumCancel = job.cancel;
      try {
        await job.promise;
      } finally {
        button._ytSumCancel = null;
        button.classList.remove(LOADING_CLASS);
        button.textContent = label;
      }
    });
    return button;
  }
  var CONTAINER_SELECTOR = VIDEO_CONTAINER_SELECTORS.join(",");
  function addFeedButtons() {
    let added = 0;
    for (const selector of VIDEO_CONTAINER_SELECTORS) {
      const isCompact = selector === "ytd-compact-video-renderer" || selector === "yt-lockup-view-model";
      for (const container of document.querySelectorAll(selector)) {
        if (container.querySelector(`.${BTN_CLASS}`)) continue;
        if (container.parentElement?.closest(CONTAINER_SELECTOR)?.querySelector(`.${BTN_CLASS}`)) continue;
        const videoLink = container.querySelector('a[href*="/watch?v="]');
        if (!videoLink) continue;
        const videoId = extractVideoId(videoLink.href || videoLink.getAttribute("href"));
        if (!videoId) continue;
        const title = getVideoTitle(container, videoLink) || "Untitled Video";
        const button = makeButton({
          label: "\u{1F4DD} Summarize",
          title: "Get an AI summary of this video",
          run: () => summarizeVideo({ videoId, title })
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
      label: "\u{1F4DD} Summarize",
      title: "Summarize this video in the side panel",
      run: () => summarizeVideo({ videoId, title })
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
          summarizeVideo({ videoId, title });
        }
      } else if (message?.type === MSG.SUMMARY_PROGRESS) {
        if (message.target === "sidebar") {
          publish({ status: "streaming", text: message.text });
        }
      }
      return false;
    });
  }
  console.log("[YT Summarizer] content script loaded");
  init();
})();
