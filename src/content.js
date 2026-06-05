// Content script — injected on www.youtube.com (isolated world).
//
// Responsibilities:
//   • Home/feed: add a "Summarize" button to every video; click → in-page modal.
//   • Watch page: add a "Summarize in sidebar" button; result renders in the
//     Chrome side panel via the background pub/sub.
//   • Fetch the transcript here (same-origin, logged-in session) and hand it to
//     the background SW, which holds the API key and calls Gemini.

import { fetchTranscript, describeTranscriptFailure } from "./lib/transcript.js";
import {
	VIDEO_CONTAINER_SELECTORS,
	extractVideoId,
	getVideoTitle,
	getWatchVideoId,
	insertButton,
} from "./lib/youtube-dom.js";
import { openLoadingModal, showError, showSummary, showStreamingText } from "./lib/modal.js";
import { storageGet } from "./lib/storage.js";
import { MSG } from "./lib/messages.js";

const BTN_CLASS = "yt-sum-summarize-btn";
const WATCH_BTN_ID = "yt-sum-watch-btn";
const LOADING_CLASS = "yt-sum-loading";

function sendMessage(message) {
	return new Promise((resolve) => {
		try {
			chrome.runtime.sendMessage(message, (resp) => {
				// Swallow "receiving end does not exist" during SW restarts.
				void chrome.runtime?.lastError;
				resolve(resp);
			});
		} catch (_) {
			resolve(undefined);
		}
	});
}

// ── Shared summarize flow ────────────────────────────────────────────────────

async function summarizeVideo({ videoId, title, target }) {
	const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
	const sidebar = target === "sidebar";
	let modalToken = null;
	let panelOpened = false;

	if (sidebar) {
		publish({ status: "loading", videoId, title });
		// sidePanel.open() needs a user gesture and the gesture doesn't survive the
		// message hop to the SW on every Chrome build — so we ask, then check.
		const opened = await sendMessage({ type: MSG.OPEN_SIDE_PANEL });
		panelOpened = opened?.opened === true;
	} else {
		const { darkMode } = await storageGet(["darkMode"]);
		modalToken = openLoadingModal(title || "Summary", { darkMode: !!darkMode });
	}

	// Transcript fast-path (same-origin). Failure is usually fine — background
	// falls back to Gemini video understanding — except for restricted videos
	// (sign-in/age/members), which the fallback also can't reach.
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
		token: modalToken,
	});

	emit(
		sidebar,
		resp?.ok
			? { ok: true, text: resp.text, mode: resp.mode }
			: { ok: false, error: resp?.error || "Failed to summarize. Please try again." },
		ctx,
	);
}

// Route a finished result to the right surface (modal or side panel).
function emit(sidebar, result, ctx) {
	if (sidebar) {
		if (result.ok) {
			publish({ status: "done", videoId: ctx.videoId, title: ctx.resolvedTitle, text: result.text, mode: result.mode });
		} else {
			publish({ status: "error", videoId: ctx.videoId, title: ctx.resolvedTitle, error: result.error });
		}
		// If the panel didn't open from the click, the summary is waiting in it —
		// don't let the button look like it did nothing.
		if (!ctx.panelOpened) {
			showToast("Summary ready — click the extension icon to open the sidebar.");
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

// Brief auto-dismissing page toast (used when the side panel couldn't auto-open).
function showToast(message) {
	document.getElementById("yt-sum-toast")?.remove();
	const toast = document.createElement("div");
	toast.id = "yt-sum-toast";
	toast.className = "yt-sum-toast";
	toast.textContent = message;
	document.body.appendChild(toast);
	setTimeout(() => toast.classList.add("yt-sum-toast-hide"), 5000);
	setTimeout(() => toast.remove(), 5400);
}

// ── Buttons ──────────────────────────────────────────────────────────────────

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
	button.textContent = "⏳ Summarizing…";
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
				label: isCompact ? "📝 Summarize" : "📝 Summarize",
				title: "Get an AI summary of this video",
				onClick: (btn) =>
					withButtonLoading(btn, () =>
						summarizeVideo({ videoId, title, target: "modal" }),
					),
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

	// Not on a watch page: remove any leftover button.
	if (!videoId) {
		existing?.remove();
		return;
	}
	// Already present for THIS video: nothing to do. For a different video
	// (YouTube SPA-navigated without reload), rebuild so the button doesn't
	// summarize the previous video.
	if (existing) {
		if (existing.dataset.videoId === videoId) return;
		existing.remove();
	}

	// Insert next to the video title in the watch metadata block.
	const titleEl = document.querySelector(
		"ytd-watch-metadata #title, #above-the-fold #title, h1.ytd-watch-metadata",
	);
	if (!titleEl) return;

	const title =
		document.querySelector("ytd-watch-metadata #title yt-formatted-string, h1.ytd-watch-metadata")?.textContent?.trim() ||
		document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();

	const button = makeButton({
		label: "📝 Summarize in sidebar",
		title: "Summarize this video in the side panel",
		onClick: (btn) =>
			withButtonLoading(btn, () =>
				summarizeVideo({ videoId, title, target: "sidebar" }),
			),
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

// ── Lifecycle ────────────────────────────────────────────────────────────────

function init() {
	const start = () => setTimeout(scanAndInject, 800);
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", start);
	} else {
		start();
	}

	// Debounced re-scan for infinite scroll / dynamic content.
	let t;
	const observer = new MutationObserver(() => {
		clearTimeout(t);
		t = setTimeout(scanAndInject, 500);
	});
	setTimeout(() => {
		if (document.body) observer.observe(document.body, { childList: true, subtree: true });
	}, 1500);

	// SPA navigation (YouTube doesn't full-reload). yt-navigate-finish fires on
	// in-app nav; also poll the URL as a backstop.
	document.addEventListener("yt-navigate-finish", () => setTimeout(scanAndInject, 800));
	let lastUrl = location.href;
	setInterval(() => {
		if (location.href !== lastUrl) {
			lastUrl = location.href;
			setTimeout(scanAndInject, 1000);
		}
	}, 1000);

	// Panel-initiated summarize ("Summarize current video" button in the side panel).
	// Also handles streaming progress from the background service worker.
	// Fire-and-forget: no response is expected, so return false (not true).
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
