// Side panel script. Two views: Summary (the watch-page result) and Settings
// (API key + dark mode). Renders summaries pushed by the background pub/sub.

import { formatSummary } from "./lib/markdown.js";
import { storageGet, storageSet } from "./lib/storage.js";
import { MSG } from "./lib/messages.js";
import { buildTranscriptPrompt } from "./lib/summarize.js";

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
	// The video the current chat belongs to. Used to ignore redundant "loading"
	// broadcasts for the same video so they can't wipe an active/summarized chat
	// (which would make the Summarize button vanish after a click).
	let chatVideoId = null;

	function clearChat() {
		if (chatStreaming) {
			chrome.runtime.sendMessage({ type: MSG.CHAT_STOP }, () => { void chrome.runtime?.lastError; });
		}
		chatHistory = [];
		chatStreaming = false;
		pendingChatText = "";
		transcriptForSummarize = null;
		chatVideoId = null;
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
			// Full prompt sent to Gemini, with the bulky transcript collapsed into an
			// inline pill. _rawText keeps the complete prompt so Copy includes it.
			div._rawText = text || "";
			const splitIdx = text ? text.indexOf("\nTRANSCRIPT:\n") : -1;
			if (splitIdx !== -1) {
				content.innerHTML =
					formatSummary(text.slice(0, splitIdx)) +
					'<p>TRANSCRIPT: <span class="transcript-pill">📄 Transcript</span></p>';
			} else {
				content.innerHTML = '<span class="transcript-pill">📄 Transcript</span>';
			}
		} else if (text) {
			div._rawText = text;
			content.innerHTML = role === "model" ? formatSummary(text) : escapeHtml(text);
		}
		div.appendChild(content);

		// Copy button on the summarize prompt and on model responses (hidden via CSS
		// while a model bubble is still an empty streaming placeholder).
		if (role === "model" || opts.displayType === "transcript") {
			div.appendChild(makeCopyBtn(() => div._rawText));
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

		// No prior turns and no summary yet → seed the transcript as context so the
		// model can answer. Hidden (not appended as a bubble); persists for follow-ups.
		if (!chatHistory.length && transcriptForSummarize) {
			chatHistory.push(
				{ role: "user", text: buildTranscriptContext() },
				{ role: "model", text: "Got it — I've read the transcript. What would you like to know?" },
			);
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

		try {
			chrome.runtime.sendMessage(
				{ type: MSG.CHAT_MESSAGE, history: outgoingHistory, context },
				(resp) => {
					void chrome.runtime?.lastError;
					setChatSendState(false);

					if (resp?.cancelled) {
						// Keep partial text if the user stopped mid-stream.
						if (pendingChatText) {
							chatHistory.push({ role: "user", text }, { role: "model", text: pendingChatText });
							fillModel(modelBubble, pendingChatText);
						} else {
							modelBubble.remove();
						}
						return;
					}

					if (resp?.ok && resp.text) {
						chatHistory.push({ role: "user", text }, { role: "model", text: resp.text });
						fillModel(modelBubble, resp.text);
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
		const prompt = buildTranscriptPrompt({ title: summaryContext.title, transcript: transcriptForSummarize });
		const outgoingHistory = [{ role: "user", text: prompt, displayType: "transcript" }];
		appendChatMessage("user", prompt, { displayType: "transcript" });
		const modelBubble = appendChatMessage("model", "");
		// One-shot: the summary is now in the chat, so hide the button. It comes back
		// only when a new video reaches transcript_ready.
		els.summarizeForChatBtn.setAttribute("hidden", "");
		els.chatInput.disabled = false;
		setChatSendState(true);
		pendingChatText = "";
		chrome.runtime.sendMessage(
			{ type: MSG.CHAT_MESSAGE, history: outgoingHistory, context: summaryContext },
			(resp) => {
				void chrome.runtime?.lastError;
				setChatSendState(false);
				if (resp?.cancelled) {
					if (pendingChatText) {
						chatHistory.push({ role: "user", text: prompt }, { role: "model", text: pendingChatText });
						fillModel(modelBubble, pendingChatText);
						summaryContext.summary = pendingChatText;
					} else {
						modelBubble.remove();
					}
					return;
				}
				if (resp?.ok && resp.text) {
					chatHistory.push({ role: "user", text: prompt }, { role: "model", text: resp.text });
					summaryContext.summary = resp.text;
					fillModel(modelBubble, resp.text);
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
		if (message?.type === MSG.SUMMARY_READY) renderState(message.state);

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
		if (resp?.state) renderState(resp.state);
	});

	function renderState(state) {
		if (!state) return;

		// A cancelled/idle run resets the panel to its empty prompt.
		if (state.status === "idle") {
			els.summaryStatus.className = "summary-status";
			els.summaryStatus.textContent = "";
			els.summaryBody.innerHTML = "";
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

		if (state.status === "loading") {
			// Ignore a redundant loading broadcast for the video we're already
			// working with — otherwise clearChat() would wipe the active chat and the
			// Summarize button after a click. A genuinely new video has a new id.
			if (chatVideoId && state.videoId === chatVideoId) return;
			// Fetching the transcript. Hide the chat entirely and show a standalone
			// "Fetching transcript…" indicator; the chat reappears at transcript_ready.
			clearChat();
			els.summaryStatus.className = "summary-status";
			els.summaryStatus.innerHTML =
				'<span class="loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> Fetching transcript…';
			els.summaryBody.innerHTML = "";
		} else if (state.status === "transcript_ready") {
			transcriptForSummarize = state.transcript;
			chatVideoId = state.videoId || null;
			summaryContext = { title: state.title || "", summary: "" };
			els.summaryStatus.className = "summary-status";
			els.summaryStatus.textContent = "";
			els.summaryBody.innerHTML = "";
			// Nothing to show up top in the chat flow — collapse viewTop so the chat
			// starts right under the header instead of after a blank gap.
			els.viewTop.setAttribute("hidden", "");
			showChat();
			els.summarizeForChatBtn.removeAttribute("hidden");
			// Typable right away: the user can skip Summarize and ask directly — the
			// transcript is sent as context with that first question (see sendChatMessage).
			els.chatInput.disabled = false;
			document.body.classList.add("chat-active");
			// Drop the keyboard user straight into the question box.
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
			chatVideoId = state.videoId || null;
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
