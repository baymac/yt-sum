// Background service worker. Holds the Gemini API key and is the hub for the
// side-panel pub/sub. The key never leaves this context.

import { callGeminiStreaming, buildRequestBody, GEMINI_MODEL } from "./lib/summarize.js";
import { storageGet } from "./lib/storage.js";
import { MSG, SESSION_KEY } from "./lib/messages.js";

// Chat is tuned hotter and shorter than the summarize path (which uses 0.3 /
// 8192): a touch more conversational, capped so a single answer stays snappy.
const CHAT_GENERATION_CONFIG = { temperature: 0.5, maxOutputTokens: 4096 };

// ── Side panel wiring ────────────────────────────────────────────────────────

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

// ── Session state for the side panel ─────────────────────────────────────────

async function setSessionState(state) {
	try {
		await chrome.storage.session.set({ [SESSION_KEY]: state });
	} catch (e) {
		console.error("[YT Summarizer] session set:", e);
	}
	// Notify any open panel. Ignore "no receiver" errors.
	try {
		chrome.runtime.sendMessage({ type: MSG.SUMMARY_READY, state }, () => {
			void chrome.runtime?.lastError;
		});
	} catch (_) {
		/* no panel open */
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

// ── Message hub ──────────────────────────────────────────────────────────────

// When video mode is used, validate that the URL is a YouTube domain to prevent
// the Gemini API key from being leveraged to process attacker-controlled URLs.
const YOUTUBE_DOMAIN_RE = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com|youtu\.be)\//;

// In-flight Gemini requests, keyed by videoId, so a cancel from any surface
// (modal close, watch button, side-panel) can abort the actual network call.
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
			setSessionState(message.payload);
			sendResponse?.({ ok: true });
			return false;

		case MSG.OPEN_SIDE_PANEL:
			openSidePanel(sender).then((opened) => sendResponse({ ok: true, opened }));
			return true; // async response

		case MSG.SUMMARY_STATE_REQUEST:
			getSessionState().then((state) => sendResponse({ ok: true, state }));
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

// The transcript/summary context is already woven into `history` by the panel
// (a hidden seed turn), so the wire just maps each turn to a Gemini content.
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
		const opts = {};
		if (sender?.tab?.windowId != null) opts.windowId = sender.tab.windowId;
		else if (sender?.tab?.id != null) opts.tabId = sender.tab.id;
		await chrome.sidePanel?.open?.(opts);
		return true;
	} catch (e) {
		// open() requires a user gesture; if it's rejected the panel can still be
		// opened from the toolbar icon and will pick up the published summary.
		// The caller shows the user a hint in that case.
		console.debug("[YT Summarizer] sidePanel.open skipped:", e?.message || e);
		return false;
	}
}
