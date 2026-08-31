// Side panel script. Two views: Summary (the watch-page result) and Settings
// (API key + dark mode). Renders summaries pushed by the background pub/sub.

import { formatSummary } from "./lib/markdown.js";
import { storageGet, storageSet } from "./lib/storage.js";
import { MSG } from "./lib/messages.js";
import { buildTranscriptPrompt } from "./lib/summarize.js";
import { buildPagePrompt, buildPageContext } from "./lib/page.js";

const $ = (id) => document.getElementById(id);

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
		apiKey: $("apiKey"),
		saveBtn: $("saveBtn"),
		status: $("status"),
		darkToggle: $("darkModeToggle"),
		chatSection: $("chatSection"),
		chatMessages: $("chatMessages"),
		chatInput: $("chatInput"),
		chatSendBtn: $("chatSendBtn"),
		summarizeForChatBtn: $("summarizeForChatBtn"),
	};

	// ── Settings load ──────────────────────────────────────────────────────────
	const { geminiApiKey, darkMode } = await storageGet(["geminiApiKey", "darkMode"]);
	if (geminiApiKey) els.apiKey.value = geminiApiKey;
	if (darkMode) {
		document.body.classList.add("dark-mode");
		els.darkToggle.classList.add("active");
	}

	// ── View toggle ────────────────────────────────────────────────────────────
	// Settings is a fully independent screen. We remember the panel title (usually
	// the video title) and whether the summary was in its sticky chat-active layout
	// so closing settings restores both — and we drop chat-active while settings is
	// open so its flex/overflow rules can't bleed the summary in behind it.
	let settingsTitleSaved = null;
	let settingsPrevChatActive = false;
	els.settingsToggle.addEventListener("click", () => {
		const showSettings = els.settingsView.hasAttribute("hidden");
		if (showSettings) {
			settingsTitleSaved = els.panelTitle.textContent;
			els.panelTitle.textContent = "⚙️ Settings";
			settingsPrevChatActive = document.body.classList.contains("chat-active");
			document.body.classList.remove("chat-active");
		} else {
			els.panelTitle.textContent = settingsTitleSaved || "📝 Summarizer";
			settingsTitleSaved = null;
			document.body.classList.toggle("chat-active", settingsPrevChatActive);
		}
		els.settingsView.toggleAttribute("hidden", !showSettings);
		els.summaryView.toggleAttribute("hidden", showSettings);
		els.settingsToggle.textContent = showSettings ? "←" : "⚙️";
		els.settingsToggle.title = showSettings ? "Back to summary" : "Settings";
	});

	// ── Dark mode ──────────────────────────────────────────────────────────────
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

	// ── Save API key ───────────────────────────────────────────────────────────
	els.saveBtn.addEventListener("click", async () => {
		const key = els.apiKey.value.trim();
		if (!key) return showStatus(els.status, "Please enter an API key", "error");
		try {
			await storageSet({ geminiApiKey: key });
			showStatus(els.status, "API key saved.", "success");
			setTimeout(() => (els.status.className = "status"), 2000);
		} catch (_) {
			showStatus(els.status, "Failed to save API key.", "error");
		}
	});

	// ── Chat state ─────────────────────────────────────────────────────────────
	// Context stored when summary finishes — used as system context for chat.
	let summaryContext = { title: "", summary: "" };
	// Completed turns pushed once we have a full exchange.
	let chatHistory = [];
	let chatStreaming = false;
	let pendingChatText = "";
	// Cleaned+clamped transcript from transcript_ready, used by startSummarize().
	let transcriptForSummarize = null;
	// Clamped page text from page_ready (non-YouTube pages), used by startSummarize().
	let pageForSummarize = null;
	let pageMeta = { url: "", title: "" };
	// The kind of surface the current chat is grounded in: 'youtube' or 'page'.
	let currentKind = "youtube";
	// The tab this panel is currently showing; chat is cached per tab under this id.
	let currentTabId = null;
	// The source the current chat belongs to ('yt:<videoId>' or 'page:<url>'). Used
	// to ignore redundant "loading" broadcasts for the same source so they can't
	// wipe an active/summarized chat (which would make Summarize vanish after click).
	let chatSourceKey = null;

	function clearChat() {
		if (chatStreaming) {
			chrome.runtime.sendMessage({ type: MSG.CHAT_STOP }, () => { void chrome.runtime?.lastError; });
		}
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

	// Copy-to-clipboard button. getText() is read at click time so streaming model
	// bubbles copy their final/current text. The transcript prompt copies the FULL
	// prompt (instruction + title + transcript), not the collapsed pill.
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
				try { document.execCommand("copy"); } catch (_) {}
				ta.remove();
			}
			btn.textContent = "Copied";
			btn.classList.add("copied");
			setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1200);
		});
		return btn;
	}

	// ── Export to Obsidian vault ───────────────────────────────────────────────
	// The browser sandbox forbids writing to a hardcoded absolute path, so we use
	// the File System Access API: the user picks the vault folder once, we keep the
	// directory handle in IndexedDB, and every later export writes straight there.
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
		const safe =
			(title || "Summary").replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Summary";
		const d = new Date();
		const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		return `${safe} ${stamp}.md`;
	}

	function buildExportDoc(title, url, md) {
		const fm = [
			"---",
			`title: "${String(title).replace(/"/g, '\\"')}"`,
			url ? `source: ${url}` : null,
			`exported: ${new Date().toISOString()}`,
			"---",
			"",
		].filter((l) => l !== null).join("\n");
		return `${fm}\n${md}\n`;
	}

	// Return the vault directory handle, prompting the one-time folder pick and
	// re-requesting permission when the browser has dropped it since last session.
	async function getVaultDir() {
		let handle = await idbGet("vaultDir").catch(() => null);
		if (handle) {
			let perm = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
			if (perm !== "granted") perm = await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
			if (perm !== "granted") handle = null;
		}
		if (!handle) {
			handle = await window.showDirectoryPicker({ mode: "readwrite", id: "obsidianVault" });
			await idbSet("vaultDir", handle).catch(() => {});
		}
		return handle;
	}

	// Fallback when the File System Access API is unavailable: a normal download
	// (lands in the browser's Downloads folder, not the vault).
	function anchorDownload(filename, content) {
		const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10000);
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
				btn.textContent = vault ? "Exported ✓" : "Downloaded";
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

	// Set a model bubble's content. Stores the raw markdown on the wrapper so its
	// copy button copies the source text, not rendered HTML.
	function fillModel(wrap, rawText, html) {
		wrap._rawText = rawText || "";
		wrap._content.innerHTML = html != null ? html : formatSummary(rawText || "");
		wrap.classList.remove("chat-bubble-empty");
	}

	function appendChatMessage(role, text, opts = {}) {
		const div = document.createElement("div");
		const hasContent = text || opts.displayType === "transcript";
		div.className = `chat-bubble chat-bubble-${role}${hasContent ? "" : " chat-bubble-empty"}`;

		// Content lives in its own node so streaming innerHTML updates don't clobber
		// the copy button.
		const content = document.createElement("div");
		content.className = "chat-bubble-content";
		div._content = content;
		div._rawText = "";

		if (opts.displayType === "transcript") {
			// The full prompt sent to Gemini. Rendered as a compact ~2-line box the
			// user can click to expand; the bulky transcript/article body stays behind
			// a pill even when expanded. _rawText keeps the complete prompt so Copy
			// includes it. Tagged so the chat can be re-serialized for caching.
			div._rawText = text || "";
			div._displayType = "transcript";
			const isArticle = text ? text.includes("\nARTICLE:\n") : false;
			const marker = isArticle ? "\nARTICLE:\n" : "\nTRANSCRIPT:\n";
			const label = isArticle ? "📄 Article" : "📄 Transcript";
			const splitIdx = text ? text.indexOf(marker) : -1;
			const instruction = splitIdx !== -1 ? text.slice(0, splitIdx) : (text || "");
			const preview = instruction.replace(/\s+/g, " ").trim().slice(0, 180);
			content.innerHTML =
				'<div class="collapsible-msg collapsed" role="button" tabindex="0" aria-expanded="false">' +
				`<div class="collapsible-preview">${escapeHtml(preview)}<span class="collapsible-hint"> ▾ show</span></div>` +
				'<div class="collapsible-full">' +
				formatSummary(instruction) +
				`<p><span class="transcript-pill">${label}</span></p>` +
				'<span class="collapsible-hint">▴ hide</span></div>' +
				"</div>";
			const box = content.querySelector(".collapsible-msg");
			const toggle = () => {
				const collapsed = box.classList.toggle("collapsed");
				box.setAttribute("aria-expanded", String(!collapsed));
			};
			box.addEventListener("click", toggle);
			box.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
			});
		} else if (text) {
			div._rawText = text;
			content.innerHTML = role === "model" ? formatSummary(text) : escapeHtml(text);
		}
		div.appendChild(content);

		// Action row (Copy, and Export for model responses) on the summarize prompt
		// and on model responses (hidden via CSS while a model bubble is still an
		// empty streaming placeholder).
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

	// Primes the chat with the transcript so Gemini has context. Used when the user
	// asks a question before clicking Summarize — without it the model would have
	// nothing to answer from. Seeded as a hidden turn (not shown as a bubble) so
	// every later question keeps the context too.
	function buildTranscriptContext() {
		const head = summaryContext.title ? `Video title: ${summaryContext.title}\n\n` : "";
		return `You are answering questions about a YouTube video using its transcript as the source. If the transcript doesn't cover something, say so.\n\n${head}TRANSCRIPT:\n${transcriptForSummarize}`;
	}

	async function sendChatMessage() {
		const text = els.chatInput.value.trim();
		if (!text || chatStreaming) return;

		// No prior turns and no summary yet → seed the transcript/article as context
		// so the model can answer. Hidden (not appended as a bubble); persists for
		// follow-ups.
		if (!chatHistory.length && (transcriptForSummarize || pageForSummarize)) {
			const seed = currentKind === "page"
				? buildPageContext({ title: pageMeta.title, url: pageMeta.url, pageText: pageForSummarize })
				: buildTranscriptContext();
			const ack = currentKind === "page"
				? "Got it — I've read the article. What would you like to know?"
				: "Got it — I've read the transcript. What would you like to know?";
			chatHistory.push({ role: "user", text: seed }, { role: "model", text: ack });
		}

		els.chatInput.value = "";
		autoResizeInput(els.chatInput);

		appendChatMessage("user", text);
		const modelBubble = appendChatMessage("model", "");

		// Full conversation to send (current history + new user message).
		const outgoingHistory = [...chatHistory, { role: "user", text }];

		setChatSendState(true);
		pendingChatText = "";

		const context = { ...summaryContext };
		const sendTabId = currentTabId;

		try {
			chrome.runtime.sendMessage(
				{ type: MSG.CHAT_MESSAGE, history: outgoingHistory, context },
				(resp) => {
					void chrome.runtime?.lastError;
					setChatSendState(false);
					// The user switched tabs while awaiting the reply — drop it so we
					// never write one tab's answer into another tab's cached chat.
					if (currentTabId !== sendTabId) return;

					if (resp?.cancelled) {
						// Keep partial text if the user stopped mid-stream.
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
						fillModel(modelBubble, "", `<span role="alert" style="color:#c62828">${escapeHtml(resp?.error || "Failed to get response.")}</span>`);
					}
				},
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
		const prompt = currentKind === "page"
			? buildPagePrompt({ title: pageMeta.title, url: pageMeta.url, pageText: pageForSummarize })
			: buildTranscriptPrompt({ title: summaryContext.title, transcript: transcriptForSummarize });
		const outgoingHistory = [{ role: "user", text: prompt, displayType: "transcript" }];
		appendChatMessage("user", prompt, { displayType: "transcript" });
		const modelBubble = appendChatMessage("model", "");
		// One-shot: the summary is now in the chat, so hide the button. It comes back
		// only when a new video reaches transcript_ready.
		els.summarizeForChatBtn.setAttribute("hidden", "");
		els.chatInput.disabled = false;
		setChatSendState(true);
		pendingChatText = "";
		const sendTabId = currentTabId;
		chrome.runtime.sendMessage(
			{ type: MSG.CHAT_MESSAGE, history: outgoingHistory, context: summaryContext },
			(resp) => {
				void chrome.runtime?.lastError;
				setChatSendState(false);
				// Dropped if the user switched tabs mid-request (see sendChatMessage).
				if (currentTabId !== sendTabId) return;
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
					fillModel(modelBubble, "", `<span role="alert" style="color:#c62828">${escapeHtml(resp?.error || "Failed.")}</span>`);
				}
			},
		);
	}

	// ── Chat event listeners ───────────────────────────────────────────────────
	els.chatInput.addEventListener("input", () => autoResizeInput(els.chatInput));

	els.chatInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!chatStreaming) sendChatMessage();
		}
	});

	els.chatSendBtn.addEventListener("click", () => {
		if (chatStreaming) {
			chrome.runtime.sendMessage({ type: MSG.CHAT_STOP }, () => { void chrome.runtime?.lastError; });
		} else {
			sendChatMessage();
		}
	});

	els.summarizeForChatBtn.addEventListener("click", startSummarize);

	// ── Live updates from background ───────────────────────────────────────────
	chrome.runtime.onMessage.addListener((message) => {
		if (message?.type === MSG.SUMMARY_READY) applyState(message.state);

		if (message?.type === MSG.CHAT_PROGRESS && chatStreaming) {
			pendingChatText = message.text;
			const bubbles = els.chatMessages.querySelectorAll(".chat-bubble-model");
			const last = bubbles[bubbles.length - 1];
			if (last && last._content) fillModel(last, message.text);
		}
	});

	// ── Restore last state on open ─────────────────────────────────────────────
	chrome.runtime.sendMessage({ type: MSG.SUMMARY_STATE_REQUEST }, (resp) => {
		void chrome.runtime?.lastError;
		if (resp?.state) applyState(resp.state);
	});

	// Serialize the visible chat bubbles so a tab's conversation can be cached and
	// restored verbatim when the user switches back to it.
	function collectBubbles() {
		const out = [];
		for (const div of els.chatMessages.children) {
			const role = div.classList.contains("chat-bubble-user") ? "user" : "model";
			const text = div._rawText != null ? div._rawText : (div._content ? div._content.textContent : "");
			if (!text) continue; // skip empty (still-streaming) bubbles
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

	// Persist the current conversation onto this tab's cached state.
	function persistChat() {
		if (currentTabId == null) return;
		chrome.runtime.sendMessage(
			{
				type: MSG.SAVE_CHAT,
				tabId: currentTabId,
				chat: { history: chatHistory, bubbles: collectBubbles(), summaryContext },
			},
			() => { void chrome.runtime?.lastError; },
		);
	}

	// Entry point for every broadcast/restore. A state stamped with a *different*
	// tab id means the user switched tabs → rebuild that tab's surface (chat
	// included). Same tab (or an untagged legacy state) → normal live render.
	function applyState(state) {
		if (!state) return;
		const incomingTab = state.tabId != null ? state.tabId : null;
		const isSwitch = incomingTab != null && incomingTab !== currentTabId;
		if (incomingTab != null) currentTabId = incomingTab;
		if (isSwitch) restoreTabState(state);
		else renderState(state);
	}

	function restoreTabState(state) {
		// Tear down the previous tab's chat surface before rebuilding this one's.
		if (chatStreaming) {
			chrome.runtime.sendMessage({ type: MSG.CHAT_STOP }, () => { void chrome.runtime?.lastError; });
		}
		chatHistory = [];
		chatStreaming = false;
		pendingChatText = "";
		els.chatMessages.innerHTML = "";
		setChatSendState(false);

		renderState(state);

		const chat = state.chat;
		if (chat && Array.isArray(chat.bubbles) && chat.bubbles.length) {
			chatHistory = Array.isArray(chat.history) ? [...chat.history] : [];
			if (chat.summaryContext) summaryContext = chat.summaryContext;
			restoreBubbles(chat.bubbles);
			showChat();
			els.chatInput.disabled = false;
			els.viewTop.setAttribute("hidden", "");
			document.body.classList.add("chat-active");
			// Already summarized/answered — the one-shot Summarize button isn't needed.
			els.summarizeForChatBtn.setAttribute("hidden", "");
		}
	}

	function renderState(state) {
		if (!state) return;

		// A cancelled/idle run resets the panel to its empty prompt.
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
		// Ensure summary view is visible when a result arrives. viewTop holds the
		// status/summary text; default it visible and let transcript_ready collapse
		// it (it's empty in the chat flow, so it'd leave a blank gap under the title).
		els.settingsView.setAttribute("hidden", "");
		els.summaryView.removeAttribute("hidden");
		els.viewTop.removeAttribute("hidden");
		els.settingsToggle.textContent = "⚙️";

		if (state.title) els.panelTitle.textContent = state.title;

		if (state.status === "loading" || state.status === "loading-page") {
			// Ignore a redundant loading broadcast for the source we're already
			// working with — otherwise clearChat() would wipe the active chat and the
			// Summarize button after a click. A genuinely new source has a new key.
			const key = state.status === "loading-page" ? "page:" + (state.url || "") : "yt:" + (state.videoId || "");
			if (chatSourceKey && key === chatSourceKey) return;
			// Fetching the transcript / reading the page. Hide the chat and show a
			// standalone indicator; the chat reappears at *_ready.
			clearChat();
			els.summaryStatus.className = "summary-status";
			const label = state.status === "loading-page" ? "Reading page…" : "Fetching transcript…";
			els.summaryStatus.innerHTML =
				'<span class="loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> ' + label;
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
			// Nothing to show up top in the chat flow — collapse viewTop so the chat
			// starts right under the header instead of after a blank gap.
			els.viewTop.setAttribute("hidden", "");
			showChat();
			// One-shot: only offer Summarize when the conversation is still empty. A
			// redundant broadcast (or a restored chat) must not resurrect the button.
			els.summarizeForChatBtn.toggleAttribute("hidden", els.chatMessages.children.length > 0);
			// Typable right away: the user can skip Summarize and ask directly — the
			// transcript is sent as context with that first question (see sendChatMessage).
			els.chatInput.disabled = false;
			document.body.classList.add("chat-active");
			// Drop the keyboard user straight into the question box.
			els.chatInput.focus();
		} else if (state.status === "page_ready") {
			// Non-YouTube page: its text was extracted; mirror the transcript flow.
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
			els.summaryStatus.innerHTML =
				'<span class="loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
			els.summaryBody.innerHTML = formatSummary(state.text || "");
		} else if (state.status === "error") {
			els.summaryStatus.className = "summary-status error";
			els.summaryStatus.textContent = state.error || "Failed to summarize.";
			els.summaryBody.innerHTML = "";
			clearChat();
		} else if (state.status === "done") {
			els.summaryStatus.className = "summary-status";
			els.summaryStatus.textContent = "";
			const note =
				state.mode === "video"
					? '<p class="source-note">Captions were unavailable, so Gemini watched the video to produce this.</p>'
					: "";
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

function escapeHtml(str) {
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function showStatus(el, message, type) {
	el.textContent = message;
	el.className = `status ${type}`;
}
