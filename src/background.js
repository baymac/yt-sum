// Background service worker. Holds the Gemini API key and owns per-tab state for
// the side panel. The key never leaves this context.
//
// State model: one entry per tab in chrome.storage.session (TAB_STATES_KEY).
// The side panel is a single surface per window, so the SW tracks the focused
// tab and only ever broadcasts the *active* tab's state — a video opened in a
// background tab caches silently and never hijacks the panel. Switching tabs
// rebroadcasts that tab's cached state (chat included), so the conversation
// reappears exactly as it was left.

import { callGeminiStreaming, buildRequestBody, GEMINI_MODEL } from "./lib/summarize.js";
import { extractPageContent, clampPageText } from "./lib/page.js";
import { isWatchUrl } from "./lib/youtube-dom.js";
import { storageGet } from "./lib/storage.js";
import { MSG, TAB_STATES_KEY } from "./lib/messages.js";

// Chat is tuned hotter and shorter than the summarize path (which uses 0.3 /
// 8192): a touch more conversational, capped so a single answer stays snappy.
const CHAT_GENERATION_CONFIG = { temperature: 0.5, maxOutputTokens: 4096 };

// ── Side panel wiring ────────────────────────────────────────────────────────

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

// ── Per-tab state store (chrome.storage.session) ─────────────────────────────

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
	const next = { ...(all[tabId] || {}), ...patch, tabId };
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

// ── Active-tab tracking & broadcast ──────────────────────────────────────────

async function getActiveTab() {
	try {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
		return tab || null;
	} catch (_) {
		return null;
	}
}

// Notify the open panel of a state. Ignore "no receiver" (panel closed).
function broadcast(state) {
	try {
		chrome.runtime.sendMessage({ type: MSG.SUMMARY_READY, state }, () => {
			void chrome.runtime?.lastError;
		});
	} catch (_) {
		/* no panel open */
	}
}

async function broadcastIfActive(tabId, state) {
	const active = await getActiveTab();
	if (active?.id === tabId) broadcast({ ...state, tabId });
}

/** Classify a tab URL into how we can summarize it. */
function classify(url) {
	if (!url || !/^https?:\/\//i.test(url)) return "unsupported";
	if (isWatchUrl(url)) return "youtube";
	if (/^https?:\/\/(?:[^/]*\.)?youtube\.com\//i.test(url) || /^https?:\/\/youtu\.be\//i.test(url))
		return "youtube-other";
	return "page";
}

/**
 * Ensure the given (active) tab has a state, extracting page text when needed,
 * and broadcast it. YouTube tabs are driven by their content script, so here we
 * just restore the cache (or a neutral placeholder) and let it publish.
 */
async function ensureTabState(tab) {
	if (!tab || tab.id == null) return;
	const tabId = tab.id;
	const url = tab.url || "";
	const kind = classify(url);
	const cached = await getTabState(tabId);

	// Same URL already resolved → just re-broadcast (this is the tab-switch
	// restore path; it carries any cached chat).
	if (cached && cached.url === url && cached.status && cached.status !== "loading-page") {
		broadcast({ ...cached, tabId });
		return;
	}

	if (kind === "page") {
		const loading = { tabId, url, kind, status: "loading-page", title: tab.title || url };
		await setTabState(tabId, loading);
		await broadcastIfActive(tabId, loading);

		// Wait for the page to finish loading before extracting, otherwise we grab
		// a half-rendered DOM. The onUpdated(status:"complete") listener re-runs this
		// (the cached loading-page state doesn't satisfy the restore guard above).
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
				chat: null,
			};
		} else {
			next = {
				tabId,
				url,
				kind: "page",
				status: "error",
				title: tab.title || url,
				error: "Couldn't read this page's text to summarize it.",
			};
		}
		await setTabState(tabId, next);
		await broadcastIfActive(tabId, next);
		return;
	}

	if (kind === "youtube") {
		// The content script auto-fetches the transcript and publishes it; show a
		// neutral placeholder until it does (cached branch above handles restore).
		const placeholder = cached?.kind === "youtube"
			? cached
			: { tabId, url, kind, status: "idle", title: tab.title || "" };
		broadcast({ ...placeholder, tabId });
		return;
	}

	// youtube feed/home or an unsupported page (chrome://, extensions, PDFs…).
	const hint =
		kind === "youtube-other"
			? "Open a YouTube video, or switch to an article to summarize it."
			: "This page can't be summarized. Open a webpage or a YouTube video.";
	const idle = { tabId, url, kind, status: "idle", title: tab.title || "", hint };
	await setTabState(tabId, idle);
	await broadcastIfActive(tabId, idle);
}

async function extractPage(tabId) {
	try {
		const results = await chrome.scripting.executeScript({
			target: { tabId },
			func: extractPageContent,
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

// React only to the *focused* tab. A background tab that navigates just has its
// stale cache invalidated so switching to it later re-resolves fresh.
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

// Keyboard shortcut (Ctrl/Cmd+Shift+S by default; rebindable at
// chrome://extensions/shortcuts). onCommand is a user gesture, so sidePanel.open
// is allowed here.
chrome.commands?.onCommand?.addListener((command) => {
	if (command === "open_side_panel") openSidePanelForActiveTab();
});

async function openSidePanelForActiveTab() {
	const tab = await getActiveTab();
	try {
		const opts =
			tab?.windowId != null
				? { windowId: tab.windowId }
				: tab?.id != null
					? { tabId: tab.id }
					: {};
		await chrome.sidePanel?.open?.(opts);
		if (tab) ensureTabState(tab);
	} catch (e) {
		console.debug("[Summarizer] open via shortcut failed:", e?.message || e);
	}
}

// ── Message hub ──────────────────────────────────────────────────────────────

// When video mode is used, validate that the URL is a YouTube domain to prevent
// the Gemini API key from being leveraged to process attacker-controlled URLs.
const YOUTUBE_DOMAIN_RE = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\//;

// In-flight Gemini requests, keyed by videoId, so a cancel from any surface
// (watch button, side-panel) can abort the actual network call.
const activeRequests = new Map();

// Single in-flight chat request (panel enforces one-at-a-time via UI state).
let activeChatController = null;

function cancelRequest(videoId) {
	const controller = videoId && activeRequests.get(videoId);
	if (controller) {
		controller.abort();
		activeRequests.delete(videoId);
	}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	// Only process messages from this extension's own scripts.
	if (sender.id !== chrome.runtime.id) return false;

	switch (message?.type) {
		case MSG.GENERATE_SUMMARY:
			handleGenerate(message, sender, sendResponse);
			return true; // async response

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
			return true; // async response

		case MSG.SUMMARY_STATE_REQUEST:
			handleStateRequest(sendResponse);
			return true; // async response

		case MSG.CHAT_MESSAGE:
			handleChat(message, sender, sendResponse);
			return true; // async response

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

// Content script (YouTube) pushed a state. Stamp it with the sender's tab, merge
// so a redundant same-video publish keeps the cached chat, and broadcast only
// when that tab is the focused one.
async function handlePublish(payload, sender) {
	const tabId = sender?.tab?.id;
	if (tabId == null || !payload) return;
	const prev = await getTabState(tabId);
	const next = { ...(prev || {}), ...payload, tabId, kind: "youtube" };
	// A genuinely different video starts a fresh chat; anything else keeps it.
	if (payload.videoId && prev?.videoId && payload.videoId !== prev.videoId) {
		next.chat = null;
	}
	if (payload.videoId) next.sourceKey = "yt:" + payload.videoId;
	await setTabState(tabId, next);
	await broadcastIfActive(tabId, next);
}

// Panel persists its chat (history + visible bubbles + context) for a tab so it
// can be restored verbatim when the user returns to that tab.
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
	// Resolve/refresh in the background (extracts page text, etc.) and broadcast.
	ensureTabState(tab);
}

async function handleGenerate(message, sender, sendResponse) {
	try {
		// Validate videoUrl to prevent the Gemini key from being used to process
		// arbitrary URLs (only YouTube domains are valid file_data sources).
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
			videoUrl: message.videoUrl,
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
							() => { void chrome.runtime?.lastError; },
						);
					}
				},
			});
		} catch (e) {
			// Aborted by the user — not an error to surface.
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

// The transcript/summary/article context is already woven into `history` by the
// panel (a hidden seed turn), so the wire just maps each turn to a Gemini content.
function buildChatContents(history) {
	return history.map(msg => ({
		role: msg.role,
		parts: [{ text: msg.text }],
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
			generationConfig: CHAT_GENERATION_CONFIG,
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
							() => { void chrome.runtime?.lastError; },
						);
					} catch (_) {}
				},
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
		// Never let a background tab open/steal the panel.
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
		// open() requires a user gesture; if it's rejected the panel can still be
		// opened from the toolbar icon and will pick up the published summary.
		console.debug("[Summarizer] sidePanel.open skipped:", e?.message || e);
		return false;
	}
}
