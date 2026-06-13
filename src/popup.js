// Side panel script. Two views: Summary (the watch-page result) and Settings
// (API key + dark mode). Renders summaries pushed by the background pub/sub.

import { formatSummary } from "./lib/markdown.js";
import { storageGet, storageSet } from "./lib/storage.js";
import { getWatchVideoId } from "./lib/youtube-dom.js";
import { MSG } from "./lib/messages.js";

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
	const els = {
		panelTitle: $("panelTitle"),
		settingsToggle: $("settingsToggle"),
		summaryView: $("summaryView"),
		settingsView: $("settingsView"),
		summarizeBtn: $("summarizeCurrentBtn"),
		summaryStatus: $("summaryStatus"),
		summaryBody: $("summaryBody"),
		idleHint: $("idleHint"),
		apiKey: $("apiKey"),
		saveBtn: $("saveBtn"),
		status: $("status"),
		darkToggle: $("darkModeToggle"),
	};

	// ── Settings load ──────────────────────────────────────────────────────────
	const { geminiApiKey, darkMode } = await storageGet(["geminiApiKey", "darkMode"]);
	if (geminiApiKey) els.apiKey.value = geminiApiKey;
	if (darkMode) {
		document.body.classList.add("dark-mode");
		els.darkToggle.classList.add("active");
	}

	// ── View toggle ────────────────────────────────────────────────────────────
	els.settingsToggle.addEventListener("click", () => {
		const showSettings = els.settingsView.hasAttribute("hidden");
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

	// Tracks the video currently being summarized, so the Cancel click can tell
	// the background which in-flight request to abort.
	let currentVideoId = null;

	const setBusy = (busy) => {
		els.summarizeBtn.dataset.busy = busy ? "1" : "";
		els.summarizeBtn.disabled = false;
		els.summarizeBtn.textContent = busy ? "✕ Cancel" : "Summarize current video";
	};

	// ── Summarize current video / cancel ─────────────────────────────────────────
	els.summarizeBtn.addEventListener("click", async () => {
		// While a summary is running the button is a Cancel control.
		if (els.summarizeBtn.dataset.busy === "1") {
			if (currentVideoId) {
				chrome.runtime.sendMessage(
					{ type: MSG.CANCEL_SUMMARY, videoId: currentVideoId },
					() => { void chrome.runtime?.lastError; },
				);
			}
			renderState({ status: "idle" });
			return;
		}
		// Disable immediately to prevent duplicate requests while waiting for
		// the loading state broadcast from the background.
		els.summarizeBtn.disabled = true;
		const tab = await activeTab();
		const videoId = getWatchVideoId(tab?.url || "");
		if (!videoId) {
			renderState({ status: "error", error: "Open a YouTube video page first, then try again." });
			return;
		}
		try {
			chrome.tabs.sendMessage(tab.id, { type: MSG.SUMMARIZE_IN_SIDEBAR, videoId }, () => {
				// No content script on the tab (e.g. installed before this page loaded).
				if (chrome.runtime?.lastError) {
					renderState({
						status: "error",
						error: "Could not reach the video tab. Make sure you're on a youtube.com video page and reload it.",
					});
				}
			});
		} catch (_) {
			renderState({ status: "error", error: "Could not reach the YouTube tab. Reload it and retry." });
		}
	});

	// ── Live updates from background ───────────────────────────────────────────
	chrome.runtime.onMessage.addListener((message) => {
		if (message?.type === MSG.SUMMARY_READY) renderState(message.state);
	});

	// ── Restore last state on open ─────────────────────────────────────────────
	chrome.runtime.sendMessage({ type: MSG.SUMMARY_STATE_REQUEST }, (resp) => {
		void chrome.runtime?.lastError;
		if (resp?.state) renderState(resp.state);
	});

	function renderState(state) {
		if (!state) return;
		if (state.videoId) currentVideoId = state.videoId;

		// A cancelled/idle run resets the panel to its empty prompt.
		if (state.status === "idle") {
			els.summaryStatus.className = "summary-status";
			els.summaryStatus.textContent = "";
			els.summaryBody.innerHTML = "";
			els.idleHint.removeAttribute("hidden");
			setBusy(false);
			return;
		}

		els.idleHint.toggleAttribute("hidden", true);
		// Ensure summary view is visible when a result arrives.
		els.settingsView.setAttribute("hidden", "");
		els.summaryView.removeAttribute("hidden");
		els.settingsToggle.textContent = "⚙️";

		if (state.title) els.panelTitle.textContent = state.title;

		if (state.status === "loading") {
			els.summaryStatus.className = "summary-status";
			els.summaryStatus.innerHTML =
				'<span class="loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> Reading the transcript…';
			els.summaryBody.innerHTML = "";
			setBusy(true);
		} else if (state.status === "streaming") {
			els.summaryStatus.className = "summary-status";
			els.summaryStatus.innerHTML =
				'<span class="loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
			els.summaryBody.innerHTML = formatSummary(state.text || "");
			setBusy(true);
		} else if (state.status === "error") {
			els.summaryStatus.className = "summary-status error";
			els.summaryStatus.textContent = state.error || "Failed to summarize.";
			els.summaryBody.innerHTML = "";
			setBusy(false);
		} else if (state.status === "done") {
			els.summaryStatus.className = "summary-status";
			els.summaryStatus.textContent = "";
			const note =
				state.mode === "video"
					? '<p class="source-note">Captions were unavailable, so Gemini watched the video to produce this.</p>'
					: "";
			els.summaryBody.innerHTML = note + formatSummary(state.text || "");
			setBusy(false);
		}
	}
});

function showStatus(el, message, type) {
	el.textContent = message;
	el.className = `status ${type}`;
}

function activeTab() {
	return new Promise((resolve) => {
		try {
			chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
				void chrome.runtime?.lastError;
				resolve(tabs?.[0] || null);
			});
		} catch (_) {
			resolve(null);
		}
	});
}
