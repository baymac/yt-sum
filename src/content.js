// Content script — injected on www.youtube.com (isolated world).
//
// Responsibilities:
//   • Feed/home tiles, watch-page related tiles, and the watch-page button all
//     add a "📝 Summarize" button; every click renders in the Chrome side panel
//     via the background pub/sub (one unified surface — no in-page modal).
//   • Fetch the transcript here (same-origin, logged-in session) and hand it to
//     the background SW, which holds the API key and calls Gemini.
//
// Invariant: summarizing is manual-only. Opening or SPA-navigating to a video
// never auto-summarizes — only an explicit button click starts a run.

import { fetchTranscript, describeTranscriptFailure } from "./lib/transcript.js";
import {
	VIDEO_CONTAINER_SELECTORS,
	extractVideoId,
	getVideoTitle,
	getWatchVideoId,
	insertButton,
} from "./lib/youtube-dom.js";
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

// The sidebar run currently in flight. Starting a new run supersedes it: the old
// run is quietly cancelled (no "idle" flicker) and the panel heading swaps to the
// new video. There's only ever one side-panel surface, so only one job at a time.
let currentSidebarJob = null;

// Starts a summarize run rendered in the side panel. Returns { promise, cancel }:
// `cancel` aborts the in-flight Gemini request (in the background SW) and, unless
// quiet, resets the panel to idle.
function summarizeVideo({ videoId, title }) {
	const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

	// Settled once a result is rendered OR the run is cancelled. Guards against a
	// late background response overwriting a UI the user has already dismissed,
	// and makes cancel() idempotent / re-entrancy-safe.
	let settled = false;

	const cancel = ({ quiet = false } = {}) => {
		if (settled) return;
		settled = true;
		sendMessage({ type: MSG.CANCEL_SUMMARY, videoId });
		// Quiet supersede (a newer video is taking over) skips the idle publish so
		// the panel doesn't flicker between the old result and the new heading.
		if (!quiet) publish({ status: "idle", videoId, title });
	};

	const job = { videoId, cancel };

	// Supersede any in-flight run: abort it without resetting the panel, then the
	// loading publish below swaps the heading to this video.
	if (currentSidebarJob) currentSidebarJob.cancel({ quiet: true });
	currentSidebarJob = job;

	const promise = (async () => {
		publish({ status: "loading", videoId, title });
		// sidePanel.open() needs a user gesture and the gesture doesn't survive the
		// message hop to the SW on every Chrome build — so we ask, then check.
		const opened = await sendMessage({ type: MSG.OPEN_SIDE_PANEL });
		const panelOpened = opened?.opened === true;
		if (settled) return; // cancelled/superseded during setup

		// Transcript fast-path (same-origin). Failure is usually fine — background
		// falls back to Gemini video understanding — except for restricted videos
		// (sign-in/age/members), which the fallback also can't reach.
		const tr = await fetchTranscript(videoId);
		if (settled) return; // cancelled while fetching the transcript
		const resolvedTitle = title || tr.title || "Summary";
		const ctx = { videoId, resolvedTitle, panelOpened };

		if (!tr.ok && tr.reason === "not-playable") {
			settled = true;
			emit({ ok: false, error: describeTranscriptFailure(tr.reason) }, ctx);
			return;
		}

		const transcript = tr.ok ? tr.text : null;

		// Show early notice so the user knows why it's taking longer before any
		// Gemini response arrives (video mode takes ~30s vs transcript mode ~2s).
		if (!transcript) {
			publish({ status: "streaming", text: "Captions were unavailable — Gemini is watching the video…" });
		}

		const resp = await sendMessage({
			type: MSG.GENERATE_SUMMARY,
			videoId,
			videoUrl,
			title: resolvedTitle,
			transcript,
			target: "sidebar",
		});

		if (settled || resp?.cancelled) return; // cancelled while Gemini ran
		settled = true;
		emit(
			resp?.ok
				? { ok: true, text: resp.text, mode: resp.mode }
				: { ok: false, error: resp?.error || "Failed to summarize. Please try again." },
			ctx,
		);
	})();

	// Clear the slot when this run ends, but only if it's still the current job —
	// a newer run may have already taken over.
	promise.finally(() => {
		if (currentSidebarJob === job) currentSidebarJob = null;
	});

	return { promise, cancel };
}

// Route a finished result to the side panel.
function emit(result, ctx) {
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

// `run` returns { promise, cancel }. While a run is in flight the button turns
// into a Cancel control: clicking it again aborts the request instead of
// kicking off a duplicate.
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
		button.textContent = "✕ Cancel";
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

const CONTAINER_SELECTOR = VIDEO_CONTAINER_SELECTORS.join(",");

function addFeedButtons() {
	let added = 0;
	for (const selector of VIDEO_CONTAINER_SELECTORS) {
		const isCompact = selector === "ytd-compact-video-renderer" || selector === "yt-lockup-view-model";
		for (const container of document.querySelectorAll(selector)) {
			if (container.querySelector(`.${BTN_CLASS}`)) continue;
			// YouTube nests yt-lockup-view-model inside ytd-rich-item-renderer on some
			// surfaces; skip if an ancestor container already carries the button.
			if (container.parentElement?.closest(CONTAINER_SELECTOR)?.querySelector(`.${BTN_CLASS}`)) continue;
			const videoLink = container.querySelector('a[href*="/watch?v="]');
			if (!videoLink) continue;
			const videoId = extractVideoId(videoLink.href || videoLink.getAttribute("href"));
			if (!videoId) continue;
			const title = getVideoTitle(container, videoLink) || "Untitled Video";

			const button = makeButton({
				label: "📝 Summarize",
				title: "Get an AI summary of this video",
				run: () => summarizeVideo({ videoId, title }),
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
		label: "📝 Summarize",
		title: "Summarize this video in the side panel",
		run: () => summarizeVideo({ videoId, title }),
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
