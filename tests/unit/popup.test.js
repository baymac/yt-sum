// Drives the real side-panel popup.js in jsdom to lock in the Summarize-button
// behavior: it must NOT disappear after a click, and a redundant "loading"
// broadcast for the same video must not wipe an active chat.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeChrome } from "../setup.js";
import { MSG } from "../../src/lib/messages.js";

const POPUP_HTML = `
  <h1 id="panelTitle">📝 Summarizer</h1>
  <button id="settingsToggle"></button>
  <section id="summaryView">
    <div id="viewTop">
      <div id="summaryStatus"></div>
      <div id="summaryBody"></div>
      <p id="idleHint"></p>
    </div>
    <div id="chatSection" hidden>
      <div class="chat-divider"></div>
      <div id="chatMessages"></div>
      <div class="chat-input-area">
        <button id="summarizeForChatBtn" hidden>Summarize</button>
        <div class="chat-input-row">
          <textarea id="chatInput"></textarea>
          <button id="chatSendBtn">Send</button>
        </div>
      </div>
    </div>
  </section>
  <section id="settingsView" hidden>
    <div id="darkModeToggle"></div>
    <label id="apiKeyLabel"></label>
    <div id="apiKeyHelp"></div>
    <select id="provider"><option value="gemini">Gemini</option><option value="openrouter">OpenRouter</option></select>
    <input id="apiKey" type="password">
    <div id="openRouterModelGroup" hidden><input id="openRouterModel" type="text"></div>
    <button id="saveBtn"></button>
    <div id="status"></div>
  </section>
`;

const flush = () => new Promise((r) => setTimeout(r, 0));
const btn = () => document.getElementById("summarizeForChatBtn");
const isHidden = (el) => el.hasAttribute("hidden");

// Loads popup.js fresh against a chrome mock, captures its onMessage listener so
// we can broadcast SUMMARY_READY states, and lets CHAT_MESSAGE be answered.
async function loadPopup(initial = { geminiApiKey: "k" }) {
	vi.resetModules();
	document.body.innerHTML = POPUP_HTML;
	if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
	Element.prototype.scrollIntoView = () => {};

	let panelListener;
	const chrome = makeChrome(initial);
	chrome.runtime.onMessage.addListener = vi.fn((cb) => {
		panelListener = cb;
	});
	// Answer the messages the panel sends. CHAT_MESSAGE resolves to a finished
	// summary so we exercise the post-click callback path.
	chrome.runtime.sendMessage = vi.fn((msg, cb) => {
		if (msg.type === MSG.SUMMARY_STATE_REQUEST) cb?.({ state: null });
		else if (msg.type === MSG.CHAT_MESSAGE) cb?.({ ok: true, text: "## TL;DR\nSummary." });
		else cb?.({ ok: true });
	});
	globalThis.chrome = chrome;

	// Capture popup.js's DOMContentLoaded handler and run it directly instead of
	// dispatching on `document` — jsdom's document persists across tests, so
	// re-dispatching would fire every prior test's handler too (multiple popup
	// instances binding the same DOM).
	const origAdd = document.addEventListener.bind(document);
	let onReady;
	document.addEventListener = (type, fn, ...rest) => {
		if (type === "DOMContentLoaded") onReady = fn;
		else origAdd(type, fn, ...rest);
	};
	await import("../../src/popup.js");
	document.addEventListener = origAdd;
	await onReady();
	await flush();

	return {
		chrome,
		broadcast: (state) => panelListener({ type: MSG.SUMMARY_READY, state }),
	};
}

describe("popup Summarize button persistence", () => {
	beforeEach(() => {
		globalThis.chrome = makeChrome({ geminiApiKey: "k" });
	});

	it("shows the button at transcript_ready", async () => {
		const { broadcast } = await loadPopup();
		broadcast({ status: "transcript_ready", videoId: "A", title: "T", transcript: "words" });
		expect(isHidden(btn())).toBe(false);
	});

	it("saves an OpenRouter key and arbitrary model", async () => {
		const { chrome } = await loadPopup({ aiProvider: "openrouter", openRouterApiKey: "old" });
		const provider = document.getElementById("provider");
		expect(provider.value).toBe("openrouter");
		expect(document.getElementById("openRouterModelGroup").hasAttribute("hidden")).toBe(false);
		document.getElementById("apiKey").value = "or-new";
		document.getElementById("openRouterModel").value = "google/gemini-2.5-pro";
		document.getElementById("saveBtn").click();
		await flush();
		expect(chrome.storage.sync._data).toMatchObject({
			aiProvider: "openrouter",
			openRouterApiKey: "or-new",
			openRouterModel: "google/gemini-2.5-pro",
		});
	});

	it("hides the button after Summarize is clicked (one-shot)", async () => {
		const { broadcast } = await loadPopup();
		broadcast({ status: "transcript_ready", videoId: "A", title: "T", transcript: "words" });
		expect(isHidden(btn())).toBe(false);

		btn().click();
		await flush();

		// One-shot: gone after the click, but the summary rendered into the chat.
		expect(isHidden(btn())).toBe(true);
		expect(document.getElementById("chatMessages").textContent).toContain("Summary.");
	});

	it("a redundant loading broadcast for the same video keeps the chat (no re-show)", async () => {
		const { broadcast } = await loadPopup();
		broadcast({ status: "transcript_ready", videoId: "A", title: "T", transcript: "words" });
		btn().click();
		await flush();

		broadcast({ status: "loading", videoId: "A", title: "T" });
		await flush();

		// Chat survives the redundant broadcast; the clicked button stays gone.
		expect(document.getElementById("chatMessages").childElementCount).toBeGreaterThan(0);
		expect(isHidden(btn())).toBe(true);
	});

	it("adds a copy button to the prompt (incl. transcript) and to responses", async () => {
		const writes = [];
		Object.defineProperty(globalThis.navigator, "clipboard", {
			configurable: true,
			value: { writeText: (t) => { writes.push(t); return Promise.resolve(); } },
		});
		const { broadcast } = await loadPopup();
		broadcast({ status: "transcript_ready", videoId: "A", title: "T", transcript: "SECRET_TRANSCRIPT_WORDS" });
		btn().click();
		await flush();

		const userCopy = document.querySelector(".chat-bubble-user .chat-copy-btn");
		expect(userCopy).toBeTruthy();
		userCopy.click();
		await flush();
		expect(writes.some((t) => t.includes("SECRET_TRANSCRIPT_WORDS"))).toBe(true);

		const modelCopy = document.querySelector(".chat-bubble-model .chat-copy-btn");
		expect(modelCopy).toBeTruthy();
		modelCopy.click();
		await flush();
		expect(writes.some((t) => t.includes("Summary."))).toBe(true);
	});

	it("resets for a genuinely new video, then re-shows the button at its transcript_ready", async () => {
		const { broadcast } = await loadPopup();
		broadcast({ status: "transcript_ready", videoId: "A", title: "A", transcript: "a" });
		btn().click();
		await flush();

		// New video begins loading → chat clears, button hides during fetch.
		broadcast({ status: "loading", videoId: "B", title: "B" });
		await flush();
		expect(isHidden(btn())).toBe(true);

		// Its transcript arrives → button comes back.
		broadcast({ status: "transcript_ready", videoId: "B", title: "B", transcript: "b" });
		await flush();
		expect(isHidden(btn())).toBe(false);
	});
});

// Drives the actual chat send / stop / stream / error paths inside the popup.js
// closure. Unlike loadPopup above (which auto-answers CHAT_MESSAGE), this loader
// captures each CHAT_MESSAGE call so a test can invoke its callback manually and
// interleave CHAT_PROGRESS broadcasts — the only way to exercise streaming and
// stop-with-partial-text deterministically.
async function loadPopupChat() {
	vi.resetModules();
	document.body.innerHTML = POPUP_HTML;
	Element.prototype.scrollIntoView = () => {};

	let panelListener;
	const chatCalls = [];
	const stopCalls = [];
	const chrome = makeChrome({ geminiApiKey: "k" });
	chrome.runtime.onMessage.addListener = vi.fn((cb) => { panelListener = cb; });
	chrome.runtime.sendMessage = vi.fn((msg, cb) => {
		if (msg.type === MSG.SUMMARY_STATE_REQUEST) cb?.({ state: null });
		else if (msg.type === MSG.CHAT_MESSAGE) chatCalls.push({ msg, cb });
		else if (msg.type === MSG.CHAT_STOP) { stopCalls.push(msg); cb?.({ ok: true }); }
		else cb?.({ ok: true });
	});
	globalThis.chrome = chrome;

	const origAdd = document.addEventListener.bind(document);
	let onReady;
	document.addEventListener = (type, fn, ...rest) => {
		if (type === "DOMContentLoaded") onReady = fn;
		else origAdd(type, fn, ...rest);
	};
	await import("../../src/popup.js");
	document.addEventListener = origAdd;
	await onReady();
	await flush();

	const input = () => document.getElementById("chatInput");
	const sendBtn = () => document.getElementById("chatSendBtn");
	return {
		chatCalls,
		stopCalls,
		broadcast: (state) => panelListener({ type: MSG.SUMMARY_READY, state }),
		raw: (message) => panelListener(message),
		input,
		sendBtn,
		// Type into the chat box and click Send.
		typeAndSend: async (text) => { input().value = text; sendBtn().click(); await flush(); },
		messagesText: () => document.getElementById("chatMessages").textContent,
		modelBubbles: () => document.querySelectorAll(".chat-bubble-model"),
	};
}

describe("popup chat send / stop / stream", () => {
	beforeEach(() => {
		globalThis.chrome = makeChrome({ geminiApiKey: "k" });
	});

	it("seeds the transcript as hidden context on the first question, then renders the answer", async () => {
		const c = await loadPopupChat();
		c.broadcast({ status: "transcript_ready", videoId: "A", title: "My Talk", transcript: "TRANSCRIPT_BODY_XYZ" });
		await c.typeAndSend("What is this about?");

		expect(c.chatCalls).toHaveLength(1);
		const { history } = c.chatCalls[0].msg;
		// First two turns are the hidden transcript-context seed (not rendered as bubbles).
		expect(history[0].role).toBe("user");
		expect(history[0].text).toContain("TRANSCRIPT_BODY_XYZ");
		expect(history[1].role).toBe("model");
		// The user's actual question is the final turn.
		expect(history[history.length - 1]).toEqual({ role: "user", text: "What is this about?" });
		// The visible bubble shows the question but NOT the seeded transcript dump.
		expect(c.messagesText()).toContain("What is this about?");
		expect(c.messagesText()).not.toContain("TRANSCRIPT_BODY_XYZ");

		c.chatCalls[0].cb({ ok: true, text: "It covers XYZ." });
		await flush();
		expect(c.messagesText()).toContain("It covers XYZ.");
		expect(c.sendBtn().textContent).toBe("Send");
	});

	it("renders an error response in the model bubble", async () => {
		const c = await loadPopupChat();
		c.broadcast({ status: "transcript_ready", videoId: "A", title: "T", transcript: "words" });
		await c.typeAndSend("hi");

		c.chatCalls[0].cb({ ok: false, error: "Rate limited." });
		await flush();
		expect(c.messagesText()).toContain("Rate limited.");
	});

	it("the Stop button aborts streaming and keeps partial text", async () => {
		const c = await loadPopupChat();
		c.broadcast({ status: "transcript_ready", videoId: "A", title: "T", transcript: "words" });
		await c.typeAndSend("explain");

		// While in-flight the Send button becomes Stop.
		expect(c.sendBtn().textContent).toBe("Stop");
		// A streamed chunk fills the model bubble.
		c.raw({ type: MSG.CHAT_PROGRESS, text: "partial answer so far" });
		await flush();
		expect(c.messagesText()).toContain("partial answer so far");

		// Clicking Stop sends CHAT_STOP; the background then resolves as cancelled.
		c.sendBtn().click();
		await flush();
		expect(c.stopCalls).toHaveLength(1);
		c.chatCalls[0].cb({ cancelled: true });
		await flush();

		expect(c.messagesText()).toContain("partial answer so far");
		expect(c.sendBtn().textContent).toBe("Send");
	});

	it("cancelling with no streamed text removes the empty model bubble", async () => {
		const c = await loadPopupChat();
		c.broadcast({ status: "transcript_ready", videoId: "A", title: "T", transcript: "words" });
		await c.typeAndSend("explain");
		expect(c.modelBubbles()).toHaveLength(1);

		c.sendBtn().click(); // Stop before any chunk arrives.
		await flush();
		c.chatCalls[0].cb({ cancelled: true });
		await flush();

		expect(c.modelBubbles()).toHaveLength(0);
	});

	it("Enter without shift sends; shift+Enter does not", async () => {
		const c = await loadPopupChat();
		c.broadcast({ status: "transcript_ready", videoId: "A", title: "T", transcript: "words" });

		c.input().value = "first line";
		c.input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
		await flush();
		expect(c.chatCalls).toHaveLength(0);

		c.input().value = "real question";
		c.input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true }));
		await flush();
		expect(c.chatCalls).toHaveLength(1);
		expect(c.chatCalls[0].msg.history.at(-1).text).toBe("real question");
	});
});

describe("popup renderState branches", () => {
	const chatSection = () => document.getElementById("chatSection");
	const summaryBody = () => document.getElementById("summaryBody");
	const summaryStatus = () => document.getElementById("summaryStatus");

	beforeEach(() => {
		globalThis.chrome = makeChrome({ geminiApiKey: "k" });
	});

	it("done renders the summary, opens chat, and shows the video-mode note when captions were unavailable", async () => {
		const { broadcast } = await loadPopup();
		broadcast({ status: "done", videoId: "A", title: "T", text: "## TL;DR\nThe answer.", mode: "video" });
		await flush();

		expect(summaryBody().textContent).toContain("The answer.");
		expect(summaryBody().textContent).toContain("Captions were unavailable");
		expect(isHidden(chatSection())).toBe(false);
		expect(document.body.classList.contains("chat-active")).toBe(true);
	});

	it("error shows the message and clears the chat", async () => {
		const { broadcast } = await loadPopup();
		// Open a chat first so we can prove error tears it down.
		broadcast({ status: "transcript_ready", videoId: "A", title: "T", transcript: "words" });
		await flush();
		expect(isHidden(chatSection())).toBe(false);

		broadcast({ status: "error", videoId: "A", title: "T", error: "Transcript unavailable." });
		await flush();
		expect(summaryStatus().textContent).toBe("Transcript unavailable.");
		expect(summaryStatus().className).toContain("error");
		expect(isHidden(chatSection())).toBe(true);
	});

	it("idle resets to the empty prompt and clears the chat", async () => {
		const { broadcast } = await loadPopup();
		broadcast({ status: "transcript_ready", videoId: "A", title: "T", transcript: "words" });
		await flush();

		broadcast({ status: "idle" });
		await flush();
		expect(isHidden(document.getElementById("idleHint"))).toBe(false);
		expect(isHidden(chatSection())).toBe(true);
		expect(document.body.classList.contains("chat-active")).toBe(false);
	});

	it("streaming renders partial summary text under the loader", async () => {
		const { broadcast } = await loadPopup();
		broadcast({ status: "streaming", videoId: "A", title: "T", text: "## TL;DR\npartial summary" });
		await flush();
		expect(summaryBody().textContent).toContain("partial summary");
		expect(summaryStatus().querySelector(".loader")).toBeTruthy();
	});

	it("opening settings parks the title + chat-active layout and restores both on close", async () => {
		const { broadcast } = await loadPopup();
		const title = document.getElementById("panelTitle");
		const toggle = document.getElementById("settingsToggle");
		// A done summary leaves the panel titled with the video and in chat-active layout.
		broadcast({ status: "done", videoId: "A", title: "My Talk", text: "summary" });
		await flush();
		expect(title.textContent).toBe("My Talk");
		expect(document.body.classList.contains("chat-active")).toBe(true);

		toggle.click(); // open settings
		expect(title.textContent).toBe("⚙️ Settings");
		expect(document.body.classList.contains("chat-active")).toBe(false);
		expect(isHidden(document.getElementById("settingsView"))).toBe(false);

		toggle.click(); // back to summary
		expect(title.textContent).toBe("My Talk");
		expect(document.body.classList.contains("chat-active")).toBe(true);
		expect(isHidden(document.getElementById("settingsView"))).toBe(true);
	});
});

describe("popup page summary + per-tab chat cache", () => {
	beforeEach(() => {
		globalThis.chrome = makeChrome({ geminiApiKey: "k" });
	});

	it("page_ready reveals Summarize and summarizes the article via chat", async () => {
		const { broadcast } = await loadPopup();
		broadcast({ status: "page_ready", tabId: 1, kind: "page", title: "Post", url: "https://ex.com/a", pageText: "ARTICLE BODY" });
		expect(isHidden(btn())).toBe(false);
		btn().click();
		await flush();
		expect(isHidden(btn())).toBe(true);
		expect(document.getElementById("chatMessages").textContent).toContain("Summary.");
	});

	it("summarizing a page sends the article prompt (not the transcript one)", async () => {
		const c = await loadPopupChat();
		c.broadcast({ status: "page_ready", tabId: 1, kind: "page", title: "Post", url: "https://ex.com/a", pageText: "ARTICLE_BODY_123" });
		document.getElementById("summarizeForChatBtn").click();
		await flush();
		expect(c.chatCalls).toHaveLength(1);
		const prompt = c.chatCalls[0].msg.history[0].text;
		expect(prompt).toContain("summarizing an article");
		expect(prompt).toContain("ARTICLE_BODY_123");
		c.chatCalls[0].cb({ ok: true, text: "Done." });
		await flush();
	});

	it("switching to another tab and back restores that tab's cached chat verbatim", async () => {
		const { broadcast } = await loadPopup();
		// Tab 1: a YouTube transcript the user summarizes.
		broadcast({ status: "transcript_ready", tabId: 1, videoId: "A", title: "T", transcript: "words" });
		btn().click();
		await flush();
		expect(document.getElementById("chatMessages").textContent).toContain("Summary.");

		// Switch to tab 2 (a fresh page) → the old chat must clear.
		broadcast({ status: "page_ready", tabId: 2, kind: "page", title: "P2", url: "u2", pageText: "x" });
		await flush();
		expect(document.getElementById("chatMessages").textContent).not.toContain("Summary.");

		// Switch back to tab 1 with its cached chat → the conversation reappears.
		broadcast({
			status: "transcript_ready",
			tabId: 1,
			videoId: "A",
			title: "T",
			transcript: "words",
			chat: {
				history: [{ role: "user", text: "p" }, { role: "model", text: "Summary." }],
				bubbles: [{ role: "model", text: "Summary." }],
				summaryContext: { title: "T", summary: "Summary." },
			},
		});
		await flush();
		expect(document.getElementById("chatMessages").textContent).toContain("Summary.");
		// One-shot Summarize button stays hidden when a cached chat is restored.
		expect(isHidden(btn())).toBe(true);
	});
});

describe("popup collapsible summarize prompt", () => {
	beforeEach(() => {
		globalThis.chrome = makeChrome({ geminiApiKey: "k" });
	});

	it("renders the Summarize prompt as a collapsed box that expands on click", async () => {
		const { broadcast } = await loadPopup();
		broadcast({ status: "transcript_ready", tabId: 1, videoId: "A", title: "T", transcript: "SECRET_WORDS" });
		btn().click();
		await flush();

		const box = document.querySelector(".collapsible-msg");
		expect(box).toBeTruthy();
		expect(box.classList.contains("collapsed")).toBe(true);
		// The bulky transcript body is never dumped into the bubble.
		expect(document.querySelector(".chat-bubble-user").textContent).not.toContain("SECRET_WORDS");

		box.click();
		expect(box.classList.contains("collapsed")).toBe(false);
		box.click();
		expect(box.classList.contains("collapsed")).toBe(true);
	});
});

describe("popup Summarize one-shot survives re-broadcasts", () => {
	beforeEach(() => {
		globalThis.chrome = makeChrome({ geminiApiKey: "k" });
	});

	it("Summarize page button stays gone after a click even if page_ready is re-broadcast", async () => {
		const { broadcast } = await loadPopup();
		const page = { status: "page_ready", tabId: 1, kind: "page", title: "P", url: "https://ex.com/a", pageText: "BODY" };
		broadcast(page);
		expect(isHidden(btn())).toBe(false);

		btn().click();
		await flush();
		expect(isHidden(btn())).toBe(true);

		// Background re-broadcasts page_ready for the SAME tab (tab re-activated /
		// state re-requested). The one-shot button must not resurrect.
		broadcast(page);
		await flush();
		expect(isHidden(btn())).toBe(true);
	});
});

describe("popup export button", () => {
	beforeEach(() => {
		globalThis.chrome = makeChrome({ geminiApiKey: "k" });
	});

	it("model responses get Export next to Copy; the prompt bubble gets Copy only", async () => {
		const { broadcast } = await loadPopup();
		broadcast({ status: "transcript_ready", tabId: 1, videoId: "A", title: "T", transcript: "words" });
		btn().click();
		await flush();

		const modelBubble = document.querySelector(".chat-bubble-model");
		expect(modelBubble.querySelector(".chat-copy-btn")).toBeTruthy();
		expect(modelBubble.querySelector(".chat-export-btn")).toBeTruthy();

		const promptBubble = document.querySelector(".chat-bubble-user");
		expect(promptBubble.querySelector(".chat-copy-btn")).toBeTruthy();
		expect(promptBubble.querySelector(".chat-export-btn")).toBeFalsy();
	});
});
