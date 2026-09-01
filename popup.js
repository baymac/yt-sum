(() => {
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
    if (/["'`<>\s\x00-\x1f]/.test(trimmed)) return "#";
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
  function storageSet(items) {
    return new Promise((resolve, reject) => {
      try {
        const maybePromise = chrome.storage.sync.set(items, () => {
          const err = chrome.runtime?.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(resolve).catch(reject);
        }
      } catch (e) {
        reject(e);
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
    CHAT_DONE: "CHAT_DONE",
    CHAT_STOP: "CHAT_STOP",
    SAVE_CHAT: "SAVE_CHAT"
  };

  // src/lib/summarize.js
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

  // src/lib/page.js
  var MAX_PAGE_CHARS = 2e5;
  var PAGE_SUMMARY_INSTRUCTION = `You are summarizing an article so the reader does NOT have to read it. Produce a clear, well-structured Markdown summary with these sections:

## TL;DR
2-3 sentences capturing the core message.

## Key Points
A bulleted list of the main points, arguments, or steps in the order they appear. Be specific \u2014 include the concrete facts, numbers, names, and conclusions, not vague descriptions.

## Details
A few short paragraphs walking through the substance so the reader gets everything important without reading.

## Takeaways
The most useful insights or action items.

Write in plain, direct language. Do not invent content that isn't supported by the source.`;
  function clampPageText(text, max = MAX_PAGE_CHARS) {
    if (!text) return "";
    if (text.length <= max) return text;
    return `${text.slice(0, max)}

[content truncated for length]`;
  }
  function buildPagePrompt({ title, url, pageText }) {
    const head = title ? `Article title: ${title}
` : "";
    const link = url ? `URL: ${url}
` : "";
    return `${PAGE_SUMMARY_INSTRUCTION}

${head}${link}
ARTICLE:
${clampPageText(pageText)}`;
  }
  function buildPageContext({ title, url, pageText }) {
    const head = title ? `Article title: ${title}
` : "";
    const link = url ? `URL: ${url}
` : "";
    return `You are answering questions about a web article using its text as the source. If the text doesn't cover something, say so.

${head}${link}
ARTICLE:
${clampPageText(pageText)}`;
  }

  // src/popup.js
  var $ = (id) => document.getElementById(id);
  document.addEventListener("DOMContentLoaded", async () => {
    const els = {
      panelTitle: $("panelTitle"),
      settingsToggle: $("settingsToggle"),
      summaryView: $("summaryView"),
      settingsView: $("settingsView"),
      viewTop: $("viewTop"),
      summaryStatus: $("summaryStatus"),
      summaryBody: $("summaryBody"),
      idleHint: $("idleHint"),
      provider: $("provider"),
      apiKey: $("apiKey"),
      apiKeyLabel: $("apiKeyLabel"),
      apiKeyHelp: $("apiKeyHelp"),
      openRouterModelGroup: $("openRouterModelGroup"),
      openRouterModel: $("openRouterModel"),
      saveBtn: $("saveBtn"),
      status: $("status"),
      darkToggle: $("darkModeToggle"),
      chatSection: $("chatSection"),
      chatMessages: $("chatMessages"),
      chatInput: $("chatInput"),
      chatSendBtn: $("chatSendBtn"),
      summarizeForChatBtn: $("summarizeForChatBtn")
    };
    let { aiProvider, geminiApiKey, openRouterApiKey, openRouterModel, darkMode } = await storageGet([
      "aiProvider",
      "geminiApiKey",
      "openRouterApiKey",
      "openRouterModel",
      "darkMode"
    ]);
    function updateProviderFields() {
      const isOpenRouter = els.provider.value === "openrouter";
      els.apiKeyLabel.textContent = isOpenRouter ? "OpenRouter API Key" : "Gemini API Key";
      els.apiKey.placeholder = isOpenRouter ? "Enter your OpenRouter API key" : "Enter your Google Gemini API key";
      els.apiKey.value = isOpenRouter ? openRouterApiKey || "" : geminiApiKey || "";
      els.apiKeyHelp.innerHTML = isOpenRouter ? 'Get a key from <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">OpenRouter</a>. Stored only in your browser.' : 'Get a free key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio</a>. Stored only in your browser.';
      els.openRouterModelGroup.toggleAttribute("hidden", !isOpenRouter);
      if (isOpenRouter) els.openRouterModel.value = openRouterModel || "";
    }
    els.provider.value = aiProvider === "openrouter" ? "openrouter" : "gemini";
    updateProviderFields();
    els.provider.addEventListener("change", updateProviderFields);
    if (darkMode) {
      document.body.classList.add("dark-mode");
      els.darkToggle.classList.add("active");
    }
    let settingsTitleSaved = null;
    let settingsPrevChatActive = false;
    els.settingsToggle.addEventListener("click", () => {
      const showSettings = els.settingsView.hasAttribute("hidden");
      if (showSettings) {
        settingsTitleSaved = els.panelTitle.textContent;
        els.panelTitle.textContent = "\u2699\uFE0F Settings";
        settingsPrevChatActive = document.body.classList.contains("chat-active");
        document.body.classList.remove("chat-active");
      } else {
        els.panelTitle.textContent = settingsTitleSaved || "\u{1F4DD} Summarizer";
        settingsTitleSaved = null;
        document.body.classList.toggle("chat-active", settingsPrevChatActive);
      }
      els.settingsView.toggleAttribute("hidden", !showSettings);
      els.summaryView.toggleAttribute("hidden", showSettings);
      els.settingsToggle.textContent = showSettings ? "\u2190" : "\u2699\uFE0F";
      els.settingsToggle.title = showSettings ? "Back to summary" : "Settings";
    });
    const toggleDark = async () => {
      const active = els.darkToggle.classList.toggle("active");
      document.body.classList.toggle("dark-mode", active);
      await storageSet({ darkMode: active });
    };
    els.darkToggle.addEventListener("click", toggleDark);
    els.darkToggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleDark();
      }
    });
    els.saveBtn.addEventListener("click", async () => {
      const key = els.apiKey.value.trim();
      if (!key) return showStatus(els.status, "Please enter an API key", "error");
      try {
        const isOpenRouter = els.provider.value === "openrouter";
        await storageSet(
          isOpenRouter ? {
            aiProvider: "openrouter",
            openRouterApiKey: key,
            openRouterModel: els.openRouterModel.value.trim()
          } : { aiProvider: "gemini", geminiApiKey: key }
        );
        if (isOpenRouter) {
          openRouterApiKey = key;
          openRouterModel = els.openRouterModel.value.trim();
        } else {
          geminiApiKey = key;
        }
        showStatus(els.status, "Settings saved.", "success");
        setTimeout(() => els.status.className = "status", 2e3);
      } catch (_) {
        showStatus(els.status, "Failed to save API key.", "error");
      }
    });
    let summaryContext = { title: "", summary: "" };
    let chatHistory = [];
    let chatStreaming = false;
    let pendingChatText = "";
    let transcriptForSummarize = null;
    let pageForSummarize = null;
    let pageMeta = { url: "", title: "" };
    let currentKind = "youtube";
    let currentTabId = null;
    let chatSourceKey = null;
    function clearChat() {
      chatHistory = [];
      chatStreaming = false;
      pendingChatText = "";
      transcriptForSummarize = null;
      pageForSummarize = null;
      chatSourceKey = null;
      els.chatMessages.innerHTML = "";
      els.chatInput.value = "";
      els.chatInput.disabled = false;
      autoResizeInput(els.chatInput);
      setChatSendState(false);
      els.summarizeForChatBtn.setAttribute("hidden", "");
      els.chatSection.setAttribute("hidden", "");
      document.body.classList.remove("chat-active");
    }
    function showChat() {
      els.chatSection.removeAttribute("hidden");
    }
    function setChatSendState(streaming) {
      chatStreaming = streaming;
      els.chatSendBtn.textContent = streaming ? "Stop" : "Send";
      els.chatSendBtn.classList.toggle("stop", streaming);
    }
    function makeCopyBtn(getText) {
      const btn = document.createElement("button");
      btn.className = "chat-copy-btn";
      btn.type = "button";
      btn.textContent = "Copy";
      btn.title = "Copy to clipboard";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const txt = getText() || "";
        try {
          await navigator.clipboard.writeText(txt);
        } catch (_) {
          const ta = document.createElement("textarea");
          ta.value = txt;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
          } catch (_2) {
          }
          ta.remove();
        }
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = "Copy";
          btn.classList.remove("copied");
        }, 1200);
      });
      return btn;
    }
    function idbOpen() {
      return new Promise((res, rej) => {
        const r = indexedDB.open("summarizer-export", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    async function idbGet(key) {
      const db = await idbOpen();
      return new Promise((res, rej) => {
        const req = db.transaction("kv", "readonly").objectStore("kv").get(key);
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => rej(req.error);
      });
    }
    async function idbSet(key, val) {
      const db = await idbOpen();
      return new Promise((res, rej) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(val, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
    function sourceUrl() {
      if (!chatSourceKey) return "";
      if (chatSourceKey.startsWith("page:")) return chatSourceKey.slice(5);
      if (chatSourceKey.startsWith("yt:")) return "https://www.youtube.com/watch?v=" + chatSourceKey.slice(3);
      return "";
    }
    function makeFilename(title) {
      const safe = (title || "Summary").replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Summary";
      return `${safe}.md`;
    }
    function buildExportDoc(title, url, md) {
      const fm = [
        "---",
        `title: "${String(title).replace(/"/g, '\\"')}"`,
        url ? `source: ${url}` : null,
        `exported: ${(/* @__PURE__ */ new Date()).toISOString()}`,
        "---",
        ""
      ].filter((l) => l !== null).join("\n");
      return `${fm}
${md}
`;
    }
    async function getVaultDir() {
      let handle = await idbGet("vaultDir").catch(() => null);
      if (handle) {
        let perm = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
        if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
        if (perm !== "granted") handle = null;
      }
      if (!handle) {
        handle = await window.showDirectoryPicker({ mode: "readwrite", id: "obsidianVault" });
        await idbSet("vaultDir", handle).catch(() => {
        });
      }
      return handle;
    }
    function anchorDownload(filename, content) {
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1e4);
    }
    async function exportMarkdown(md) {
      const title = (summaryContext.title || els.panelTitle.textContent || "Summary").trim();
      const filename = makeFilename(title);
      const content = buildExportDoc(title, sourceUrl(), md);
      if (typeof window.showDirectoryPicker === "function") {
        const dir = await getVaultDir();
        const fileHandle = await dir.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return { filename, vault: true };
      }
      anchorDownload(filename, content);
      return { filename, vault: false };
    }
    function makeExportBtn(getText) {
      const btn = document.createElement("button");
      btn.className = "chat-export-btn";
      btn.type = "button";
      btn.textContent = "Export";
      btn.title = "Export as .md to your Obsidian vault";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const md = getText() || "";
        if (!md.trim()) return;
        btn.disabled = true;
        try {
          const { vault } = await exportMarkdown(md);
          btn.textContent = vault ? "Exported \u2713" : "Downloaded";
          btn.classList.add("copied");
        } catch (err) {
          btn.textContent = err?.name === "AbortError" ? "Cancelled" : "Failed";
          console.debug("[Summarizer] export failed:", err);
        } finally {
          setTimeout(() => {
            btn.textContent = "Export";
            btn.classList.remove("copied");
            btn.disabled = false;
          }, 1600);
        }
      });
      return btn;
    }
    function fillModel(wrap, rawText, html) {
      wrap._rawText = rawText || "";
      wrap._content.innerHTML = html != null ? html : formatSummary(rawText || "");
      wrap.classList.remove("chat-bubble-empty");
    }
    function appendChatMessage(role, text, opts = {}) {
      const div = document.createElement("div");
      const hasContent = text || opts.displayType === "transcript";
      div.className = `chat-bubble chat-bubble-${role}${hasContent ? "" : " chat-bubble-empty"}`;
      const content = document.createElement("div");
      content.className = "chat-bubble-content";
      div._content = content;
      div._rawText = "";
      if (opts.displayType === "transcript") {
        div._rawText = text || "";
        div._displayType = "transcript";
        const isArticle = text ? text.includes("\nARTICLE:\n") : false;
        const marker = isArticle ? "\nARTICLE:\n" : "\nTRANSCRIPT:\n";
        const label = isArticle ? "\u{1F4C4} Article" : "\u{1F4C4} Transcript";
        const splitIdx = text ? text.indexOf(marker) : -1;
        const instruction = splitIdx !== -1 ? text.slice(0, splitIdx) : text || "";
        const preview = instruction.replace(/\s+/g, " ").trim().slice(0, 180);
        content.innerHTML = `<div class="collapsible-msg collapsed" role="button" tabindex="0" aria-expanded="false"><div class="collapsible-preview">${escapeHtml2(preview)}<span class="collapsible-hint"> \u25BE show</span></div><div class="collapsible-full">` + formatSummary(instruction) + `<p><span class="transcript-pill">${label}</span></p><span class="collapsible-hint">\u25B4 hide</span></div></div>`;
        const box = content.querySelector(".collapsible-msg");
        const toggle = () => {
          const collapsed = box.classList.toggle("collapsed");
          box.setAttribute("aria-expanded", String(!collapsed));
        };
        box.addEventListener("click", toggle);
        box.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        });
      } else if (text) {
        div._rawText = text;
        content.innerHTML = role === "model" ? formatSummary(text) : escapeHtml2(text);
      }
      div.appendChild(content);
      if (role === "model" || opts.displayType === "transcript") {
        const actions = document.createElement("div");
        actions.className = "chat-actions";
        actions.appendChild(makeCopyBtn(() => div._rawText));
        if (role === "model") actions.appendChild(makeExportBtn(() => div._rawText));
        div.appendChild(actions);
      }
      els.chatMessages.appendChild(div);
      div.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return div;
    }
    function buildTranscriptContext() {
      const head = summaryContext.title ? `Video title: ${summaryContext.title}

` : "";
      return `You are answering questions about a YouTube video using its transcript as the source. If the transcript doesn't cover something, say so.

${head}TRANSCRIPT:
${transcriptForSummarize}`;
    }
    async function sendChatMessage() {
      const text = els.chatInput.value.trim();
      if (!text || chatStreaming) return;
      if (!chatHistory.length && (transcriptForSummarize || pageForSummarize)) {
        const seed = currentKind === "page" ? buildPageContext({ title: pageMeta.title, url: pageMeta.url, pageText: pageForSummarize }) : buildTranscriptContext();
        const ack = currentKind === "page" ? "Got it \u2014 I've read the article. What would you like to know?" : "Got it \u2014 I've read the transcript. What would you like to know?";
        chatHistory.push({ role: "user", text: seed }, { role: "model", text: ack });
      }
      els.chatInput.value = "";
      autoResizeInput(els.chatInput);
      appendChatMessage("user", text);
      const modelBubble = appendChatMessage("model", "");
      const outgoingHistory = [...chatHistory, { role: "user", text }];
      setChatSendState(true);
      pendingChatText = "";
      const context = { ...summaryContext };
      const sendTabId = currentTabId;
      try {
        chrome.runtime.sendMessage(
          {
            type: MSG.CHAT_MESSAGE,
            history: outgoingHistory,
            context,
            sourceKey: chatSourceKey,
            tabId: currentTabId,
            bubbles: collectBubbles()
          },
          (resp) => {
            void chrome.runtime?.lastError;
            if (!chatStreaming || currentTabId !== sendTabId || !modelBubble.isConnected) return;
            setChatSendState(false);
            if (resp?.cancelled) {
              if (pendingChatText) {
                chatHistory.push({ role: "user", text }, { role: "model", text: pendingChatText });
                fillModel(modelBubble, pendingChatText);
                persistChat();
              } else {
                modelBubble.remove();
              }
              return;
            }
            if (resp?.ok && resp.text) {
              chatHistory.push({ role: "user", text }, { role: "model", text: resp.text });
              fillModel(modelBubble, resp.text);
              persistChat();
            } else {
              fillModel(modelBubble, "", `<span role="alert" style="color:#c62828">${escapeHtml2(resp?.error || "Failed to get response.")}</span>`);
            }
          }
        );
      } catch (_) {
        setChatSendState(false);
        fillModel(modelBubble, "", `<span role="alert" style="color:#c62828">Error sending message.</span>`);
      }
    }
    function autoResizeInput(el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    }
    function startSummarize() {
      if (chatStreaming) return;
      const prompt = currentKind === "page" ? buildPagePrompt({ title: pageMeta.title, url: pageMeta.url, pageText: pageForSummarize }) : buildTranscriptPrompt({ title: summaryContext.title, transcript: transcriptForSummarize });
      const outgoingHistory = [{ role: "user", text: prompt, displayType: "transcript" }];
      appendChatMessage("user", prompt, { displayType: "transcript" });
      const modelBubble = appendChatMessage("model", "");
      els.summarizeForChatBtn.setAttribute("hidden", "");
      els.chatInput.disabled = false;
      setChatSendState(true);
      pendingChatText = "";
      const sendTabId = currentTabId;
      chrome.runtime.sendMessage(
        {
          type: MSG.CHAT_MESSAGE,
          history: outgoingHistory,
          context: summaryContext,
          sourceKey: chatSourceKey,
          tabId: currentTabId,
          bubbles: collectBubbles(),
          isSummary: true
        },
        (resp) => {
          void chrome.runtime?.lastError;
          if (!chatStreaming || currentTabId !== sendTabId || !modelBubble.isConnected) return;
          setChatSendState(false);
          if (resp?.cancelled) {
            if (pendingChatText) {
              chatHistory.push({ role: "user", text: prompt }, { role: "model", text: pendingChatText });
              fillModel(modelBubble, pendingChatText);
              summaryContext.summary = pendingChatText;
              persistChat();
            } else {
              modelBubble.remove();
            }
            return;
          }
          if (resp?.ok && resp.text) {
            chatHistory.push({ role: "user", text: prompt }, { role: "model", text: resp.text });
            summaryContext.summary = resp.text;
            fillModel(modelBubble, resp.text);
            persistChat();
          } else {
            fillModel(modelBubble, "", `<span role="alert" style="color:#c62828">${escapeHtml2(resp?.error || "Failed.")}</span>`);
          }
        }
      );
    }
    els.chatInput.addEventListener("input", () => autoResizeInput(els.chatInput));
    els.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!chatStreaming) sendChatMessage();
      }
    });
    els.chatSendBtn.addEventListener("click", () => {
      if (chatStreaming) {
        chrome.runtime.sendMessage({ type: MSG.CHAT_STOP, sourceKey: chatSourceKey }, () => {
          void chrome.runtime?.lastError;
        });
      } else {
        sendChatMessage();
      }
    });
    els.summarizeForChatBtn.addEventListener("click", startSummarize);
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === MSG.SUMMARY_READY) applyState(message.state);
      if (message?.type === MSG.CHAT_PROGRESS && chatStreaming && (!message.sourceKey || message.sourceKey === chatSourceKey)) {
        pendingChatText = message.text;
        const bubbles = els.chatMessages.querySelectorAll(".chat-bubble-model");
        const last = bubbles[bubbles.length - 1];
        if (last && last._content) fillModel(last, message.text);
      }
      if (message?.type === MSG.CHAT_DONE) finalizeFromBroadcast(message);
    });
    function finalizeFromBroadcast(message) {
      if (!chatStreaming || !message.sourceKey || message.sourceKey !== chatSourceKey) return;
      setChatSendState(false);
      const bubbles = els.chatMessages.querySelectorAll(".chat-bubble-model");
      const last = bubbles[bubbles.length - 1];
      if (message.chat) {
        if (Array.isArray(message.chat.history)) chatHistory = [...message.chat.history];
        if (message.chat.summaryContext) summaryContext = message.chat.summaryContext;
      }
      if (message.text) {
        if (last) fillModel(last, message.text);
      } else if (message.cancelled) {
        if (last) last.remove();
      } else if (last) {
        fillModel(last, "", `<span role="alert" style="color:#c62828">${escapeHtml2(message.error || "Failed to get response.")}</span>`);
      }
    }
    chrome.runtime.sendMessage({ type: MSG.SUMMARY_STATE_REQUEST }, (resp) => {
      void chrome.runtime?.lastError;
      if (resp?.state) applyState(resp.state);
    });
    function collectBubbles() {
      const out = [];
      for (const div of els.chatMessages.children) {
        const role = div.classList.contains("chat-bubble-user") ? "user" : "model";
        const text = div._rawText != null ? div._rawText : div._content ? div._content.textContent : "";
        if (!text) continue;
        out.push({ role, text, displayType: div._displayType });
      }
      return out;
    }
    function restoreBubbles(bubbles) {
      els.chatMessages.innerHTML = "";
      for (const b of bubbles || []) {
        appendChatMessage(b.role, b.text, b.displayType ? { displayType: b.displayType } : {});
      }
    }
    function persistChat() {
      if (currentTabId == null) return;
      chrome.runtime.sendMessage(
        {
          type: MSG.SAVE_CHAT,
          tabId: currentTabId,
          chat: { history: chatHistory, bubbles: collectBubbles(), summaryContext }
        },
        () => {
          void chrome.runtime?.lastError;
        }
      );
    }
    function stateSource(state) {
      if (state.sourceKey) return state.sourceKey;
      if (state.videoId) return "yt:" + state.videoId;
      if (state.kind === "page" && state.url) return "page:" + state.url;
      return null;
    }
    function applyState(state) {
      if (!state) return;
      const incomingTab = state.tabId != null ? state.tabId : null;
      const isSwitch = incomingTab != null && incomingTab !== currentTabId;
      if (incomingTab != null) currentTabId = incomingTab;
      const source = stateSource(state);
      const differentSource = source != null && source !== chatSourceKey;
      const hasChat = !!(state.pendingChat || state.chat && state.chat.bubbles && state.chat.bubbles.length);
      if (isSwitch || differentSource && (chatSourceKey != null || hasChat)) restoreTabState(state);
      else renderState(state);
    }
    function restoreTabState(state) {
      chatHistory = [];
      chatStreaming = false;
      pendingChatText = "";
      els.chatMessages.innerHTML = "";
      setChatSendState(false);
      renderState(state);
      const pending = state.pendingChat;
      const chat = state.chat;
      if (pending && Array.isArray(pending.bubbles)) {
        chatHistory = Array.isArray(pending.history) ? [...pending.history] : [];
        if (chat && chat.summaryContext) summaryContext = chat.summaryContext;
        restoreBubbles(pending.bubbles);
        const bubble = appendChatMessage("model", "");
        if (pending.accumulated) fillModel(bubble, pending.accumulated);
        pendingChatText = pending.accumulated || "";
        showChat();
        els.chatInput.disabled = false;
        els.viewTop.setAttribute("hidden", "");
        document.body.classList.add("chat-active");
        els.summarizeForChatBtn.setAttribute("hidden", "");
        setChatSendState(true);
      } else if (chat && Array.isArray(chat.bubbles) && chat.bubbles.length) {
        chatHistory = Array.isArray(chat.history) ? [...chat.history] : [];
        if (chat.summaryContext) summaryContext = chat.summaryContext;
        restoreBubbles(chat.bubbles);
        showChat();
        els.chatInput.disabled = false;
        els.viewTop.setAttribute("hidden", "");
        document.body.classList.add("chat-active");
        els.summarizeForChatBtn.setAttribute("hidden", "");
      }
    }
    function renderState(state) {
      if (!state) return;
      if (state.status === "idle") {
        els.summaryStatus.className = "summary-status";
        els.summaryStatus.textContent = "";
        els.summaryBody.innerHTML = "";
        if (state.hint) els.idleHint.textContent = state.hint;
        els.idleHint.removeAttribute("hidden");
        clearChat();
        return;
      }
      els.idleHint.toggleAttribute("hidden", true);
      els.settingsView.setAttribute("hidden", "");
      els.summaryView.removeAttribute("hidden");
      els.viewTop.removeAttribute("hidden");
      els.settingsToggle.textContent = "\u2699\uFE0F";
      if (state.title) els.panelTitle.textContent = state.title;
      if (state.status === "loading" || state.status === "loading-page") {
        const key = state.status === "loading-page" ? "page:" + (state.url || "") : "yt:" + (state.videoId || "");
        if (chatSourceKey && key === chatSourceKey) return;
        clearChat();
        els.summaryStatus.className = "summary-status";
        const label = state.status === "loading-page" ? "Reading page\u2026" : "Fetching transcript\u2026";
        els.summaryStatus.innerHTML = '<span class="loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> ' + label;
        els.summaryBody.innerHTML = "";
      } else if (state.status === "transcript_ready") {
        currentKind = "youtube";
        transcriptForSummarize = state.transcript;
        pageForSummarize = null;
        chatSourceKey = state.videoId ? "yt:" + state.videoId : null;
        summaryContext = { title: state.title || "", summary: "" };
        els.summarizeForChatBtn.textContent = "Summarize";
        els.summaryStatus.className = "summary-status";
        els.summaryStatus.textContent = "";
        els.summaryBody.innerHTML = "";
        els.viewTop.setAttribute("hidden", "");
        showChat();
        els.summarizeForChatBtn.toggleAttribute("hidden", els.chatMessages.children.length > 0);
        els.chatInput.disabled = false;
        document.body.classList.add("chat-active");
        els.chatInput.focus();
      } else if (state.status === "page_ready") {
        currentKind = "page";
        pageForSummarize = state.pageText;
        transcriptForSummarize = null;
        pageMeta = { url: state.url || "", title: state.title || "" };
        chatSourceKey = state.url ? "page:" + state.url : null;
        summaryContext = { title: state.title || "", summary: "" };
        els.summaryStatus.className = "summary-status";
        els.summaryStatus.textContent = "";
        els.summaryBody.innerHTML = "";
        els.viewTop.setAttribute("hidden", "");
        showChat();
        els.summarizeForChatBtn.textContent = "Summarize page";
        els.summarizeForChatBtn.toggleAttribute("hidden", els.chatMessages.children.length > 0);
        els.chatInput.disabled = false;
        document.body.classList.add("chat-active");
        els.chatInput.focus();
      } else if (state.status === "streaming") {
        els.summaryStatus.className = "summary-status";
        els.summaryStatus.innerHTML = '<span class="loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
        els.summaryBody.innerHTML = formatSummary(state.text || "");
      } else if (state.status === "error") {
        els.summaryStatus.className = "summary-status error";
        els.summaryStatus.textContent = state.error || "Failed to summarize.";
        els.summaryBody.innerHTML = "";
        clearChat();
      } else if (state.status === "done") {
        els.summaryStatus.className = "summary-status";
        els.summaryStatus.textContent = "";
        const note = state.mode === "video" ? '<p class="source-note">Captions were unavailable, so Gemini watched the video to produce this.</p>' : "";
        els.summaryBody.innerHTML = note + formatSummary(state.text || "");
        currentKind = "youtube";
        chatSourceKey = state.videoId ? "yt:" + state.videoId : null;
        summaryContext = { title: state.title || "", summary: state.text || "" };
        showChat();
        els.chatInput.disabled = false;
        document.body.classList.add("chat-active");
        els.chatInput.focus();
      }
    }
  });
  function escapeHtml2(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function showStatus(el, message, type) {
    el.textContent = message;
    el.className = `status ${type}`;
  }
})();
