import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeChrome } from "../setup.js";
import { MSG, TAB_STATES_KEY } from "../../src/lib/messages.js";

// Load background.js fresh with a chrome mock whose onMessage.addListener we
// capture, so we can drive the message hub directly.
async function loadBackground(initial = { geminiApiKey: "k" }) {
	vi.resetModules();
	let listener;
	let commandListener;
	const chrome = makeChrome(initial);
	chrome.runtime.onMessage.addListener = vi.fn((cb) => {
		listener = cb;
	});
	chrome.commands.onCommand.addListener = vi.fn((cb) => {
		commandListener = cb;
	});
	globalThis.chrome = chrome;
	await import("../../src/background.js");
	const invoke = (msg, sender = {}) =>
		new Promise((resolve) => {
			const isAsync = listener(msg, sender, resolve);
			if (isAsync !== true) resolve(undefined);
		});
	const runCommand = (name) => commandListener?.(name);
	const flush = () => new Promise((r) => setTimeout(r, 0));
	return { chrome, invoke, runCommand, flush };
}

// Mock a streaming SSE response for callGeminiStreaming.
const sseOk = (text) => {
	const chunk = new TextEncoder().encode(
		`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`,
	);
	return {
		ok: true,
		status: 200,
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(chunk);
				controller.close();
			},
		}),
	};
};

const openRouterSseOk = (text) => {
	const chunk = new TextEncoder().encode(
		`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
	);
	return {
		ok: true,
		status: 200,
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(chunk);
				controller.close();
			},
		}),
	};
};

describe("background message hub", () => {
	beforeEach(() => {
		globalThis.fetch = vi.fn(async () => sseOk("SUMMARY"));
	});

	it("GENERATE_SUMMARY calls Gemini and responds with the summary", async () => {
		const { invoke } = await loadBackground();
		const resp = await invoke({
			type: MSG.GENERATE_SUMMARY,
			videoUrl: "https://youtu.be/x",
			title: "T",
			transcript: "the words",
		});
		expect(resp).toEqual({ ok: true, text: "SUMMARY", mode: "transcript" });
	});

	it("GENERATE_SUMMARY surfaces a missing API key", async () => {
		const { invoke } = await loadBackground({});
		const resp = await invoke({ type: MSG.GENERATE_SUMMARY, transcript: "x" });
		expect(resp.ok).toBe(false);
		expect(resp.error).toMatch(/api key/i);
	});

	it("CHAT_MESSAGE sends OpenRouter's selected model and key", async () => {
		globalThis.fetch = vi.fn(async () => openRouterSseOk("OPENROUTER"));
		const { invoke } = await loadBackground({
			aiProvider: "openrouter",
			openRouterApiKey: "or-key",
			openRouterModel: "anthropic/claude-3.5-sonnet",
		});
		const resp = await invoke({ type: MSG.CHAT_MESSAGE, history: [{ role: "user", text: "Q" }] });
		expect(resp).toEqual({ ok: true, text: "OPENROUTER" });
		expect(globalThis.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer or-key");
		const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
		expect(sentBody.model).toBe("anthropic/claude-3.5-sonnet");
		expect(sentBody.messages).toEqual([{ role: "user", content: "Q" }]);
	});

	it("PUBLISH_SUMMARY stores per-tab state and broadcasts when the tab is active", async () => {
		const { chrome, invoke, flush } = await loadBackground();
		chrome.tabs.query = vi.fn(async () => [{ id: 7, windowId: 1, url: "https://www.youtube.com/watch?v=abc" }]);
		const payload = { status: "done", videoId: "abc", title: "T", text: "S", mode: "transcript" };
		await invoke({ type: MSG.PUBLISH_SUMMARY, payload }, { tab: { id: 7 } });
		await flush();
		expect(chrome.storage.session._data[TAB_STATES_KEY][7]).toMatchObject({
			...payload,
			tabId: 7,
			kind: "youtube",
			sourceKey: "yt:abc",
		});
		const broadcast = chrome.runtime.sendMessage.mock.calls.find(
			(c) => c[0]?.type === MSG.SUMMARY_READY,
		);
		expect(broadcast?.[0].state).toMatchObject(payload);
	});

	it("PUBLISH_SUMMARY from a background tab caches but does NOT broadcast", async () => {
		const { chrome, invoke, flush } = await loadBackground();
		// Active tab is 7; the publish comes from tab 9 (a background tab).
		chrome.tabs.query = vi.fn(async () => [{ id: 7, url: "https://www.youtube.com/watch?v=front" }]);
		const payload = { status: "done", videoId: "bg", title: "BG", text: "S" };
		await invoke({ type: MSG.PUBLISH_SUMMARY, payload }, { tab: { id: 9 } });
		await flush();
		expect(chrome.storage.session._data[TAB_STATES_KEY][9]).toMatchObject({ videoId: "bg", tabId: 9 });
		const broadcast = chrome.runtime.sendMessage.mock.calls.find(
			(c) => c[0]?.type === MSG.SUMMARY_READY,
		);
		expect(broadcast).toBeUndefined();
	});

	it("SUMMARY_STATE_REQUEST returns the active tab's stored state", async () => {
		const { chrome, invoke } = await loadBackground();
		chrome.tabs.query = vi.fn(async () => [{ id: 7, url: "https://example.com/a" }]);
		chrome.storage.session._data[TAB_STATES_KEY] = {
			7: { status: "done", videoId: "z", text: "S", url: "https://example.com/a", tabId: 7 },
		};
		const resp = await invoke({ type: MSG.SUMMARY_STATE_REQUEST });
		expect(resp.ok).toBe(true);
		expect(resp.state).toMatchObject({ status: "done", text: "S", tabId: 7 });
	});

	it("SAVE_CHAT persists the chat onto the tab's state", async () => {
		const { chrome, invoke, flush } = await loadBackground();
		chrome.storage.session._data[TAB_STATES_KEY] = { 7: { status: "page_ready", url: "u", tabId: 7 } };
		const chat = { history: [{ role: "user", text: "hi" }], bubbles: [], summaryContext: { title: "", summary: "" } };
		await invoke({ type: MSG.SAVE_CHAT, tabId: 7, chat });
		await flush();
		expect(chrome.storage.session._data[TAB_STATES_KEY][7].chat).toEqual(chat);
	});

	it("open_side_panel command opens the panel for the active tab's window", async () => {
		const { chrome, runCommand, flush } = await loadBackground();
		chrome.tabs.query = vi.fn(async () => [{ id: 7, windowId: 3, url: "https://example.com/a" }]);
		runCommand("open_side_panel");
		await flush();
		expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 3 });
	});

	it("OPEN_SIDE_PANEL opens the panel and reports opened:true", async () => {
		const { chrome, invoke } = await loadBackground();
		const resp = await invoke({ type: MSG.OPEN_SIDE_PANEL }, { tab: { windowId: 1, id: 2 } });
		expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 1 });
		expect(resp).toEqual({ ok: true, opened: true });
	});

	it("OPEN_SIDE_PANEL reports opened:false when the gesture is rejected", async () => {
		const { chrome, invoke } = await loadBackground();
		chrome.sidePanel.open = vi.fn(async () => {
			throw new Error("user gesture required");
		});
		const resp = await invoke({ type: MSG.OPEN_SIDE_PANEL }, { tab: { windowId: 1 } });
		expect(resp).toEqual({ ok: true, opened: false });
	});

	it("OPEN_SIDE_PANEL uses tabId when windowId is absent from the sender", async () => {
		const { chrome, invoke } = await loadBackground();
		const resp = await invoke({ type: MSG.OPEN_SIDE_PANEL }, { tab: { id: 5 } });
		expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 5 });
		expect(resp).toEqual({ ok: true, opened: true });
	});

	it("unknown message type returns undefined without crashing", async () => {
		const { invoke } = await loadBackground();
		const resp = await invoke({ type: "UNKNOWN_MSG_TYPE" });
		expect(resp).toBeUndefined();
	});

	it("CHAT_MESSAGE calls Gemini with the conversation history and returns text", async () => {
		const { invoke } = await loadBackground();
		const resp = await invoke({
			type: MSG.CHAT_MESSAGE,
			history: [{ role: "user", text: "Q1" }],
			context: { title: "T", summary: "S" },
		});
		expect(resp).toEqual({ ok: true, text: "SUMMARY" });
		// The history is sent as Gemini `contents` (role + parts[].text).
		const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
		expect(sentBody.contents).toEqual([{ role: "user", parts: [{ text: "Q1" }] }]);
		expect(sentBody.generationConfig.maxOutputTokens).toBe(4096);
	});

	it("CHAT_MESSAGE maps a multi-turn history into Gemini contents in order", async () => {
		const { invoke } = await loadBackground();
		await invoke({
			type: MSG.CHAT_MESSAGE,
			history: [
				{ role: "user", text: "hidden transcript context" },
				{ role: "model", text: "Got it." },
				{ role: "user", text: "real question" },
			],
			context: {},
		});
		const sentBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
		expect(sentBody.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
		expect(sentBody.contents[2].parts[0].text).toBe("real question");
	});

	it("CHAT_MESSAGE surfaces a missing API key", async () => {
		const { invoke } = await loadBackground({});
		const resp = await invoke({
			type: MSG.CHAT_MESSAGE,
			history: [{ role: "user", text: "Q" }],
			context: {},
		});
		expect(resp.ok).toBe(false);
		expect(resp.error).toMatch(/api key/i);
	});

	it("CHAT_MESSAGE rejects an empty history", async () => {
		const { invoke } = await loadBackground();
		const resp = await invoke({ type: MSG.CHAT_MESSAGE, history: [], context: {} });
		expect(resp.ok).toBe(false);
		expect(resp.error).toMatch(/no message/i);
	});

	it("CHAT_MESSAGE broadcasts streaming progress via CHAT_PROGRESS", async () => {
		const { chrome, invoke } = await loadBackground();
		await invoke({
			type: MSG.CHAT_MESSAGE,
			history: [{ role: "user", text: "Q" }],
			context: {},
		});
		const progress = chrome.runtime.sendMessage.mock.calls.find(
			(c) => c[0]?.type === MSG.CHAT_PROGRESS,
		);
		expect(progress?.[0].text).toBe("SUMMARY");
	});

	it("CHAT_MESSAGE reports a network failure as an error", async () => {
		// A network error is transient, so callGeminiStreaming retries 3x with a
		// 1s + 2s real backoff. Fake timers flush that instantly — we still
		// exercise the retry-then-fail path without paying 3s of wall clock.
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network down");
		});
		const { invoke } = await loadBackground();
		vi.useFakeTimers();
		try {
			const p = invoke({
				type: MSG.CHAT_MESSAGE,
				history: [{ role: "user", text: "Q" }],
				context: {},
			});
			await vi.runAllTimersAsync();
			const resp = await p;
			expect(resp.ok).toBe(false);
			expect(resp.error).toBeTruthy();
			// All 3 attempts ran (proves the retry loop executed, not a single shot).
			expect(globalThis.fetch).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("CHAT_STOP aborts an in-flight chat request and reports cancelled", async () => {
		// A fetch that never resolves until aborted, so we can drive the abort path.
		globalThis.fetch = vi.fn(
			(url, opts) =>
				new Promise((_resolve, reject) => {
					opts.signal.addEventListener("abort", () => {
						const err = new Error("aborted");
						err.name = "AbortError";
						reject(err);
					});
				}),
		);
		const { invoke } = await loadBackground();

		let chatResp;
		const chatPromise = invoke({
			type: MSG.CHAT_MESSAGE,
			history: [{ role: "user", text: "Q" }],
			context: {},
		}).then((r) => (chatResp = r));

		// Let handleChat install activeChatController before stopping.
		await new Promise((r) => setTimeout(r, 0));
		const stopResp = await invoke({ type: MSG.CHAT_STOP });
		expect(stopResp).toEqual({ ok: true });

		await chatPromise;
		expect(chatResp).toEqual({ ok: false, cancelled: true });
	});

	it("CHAT_MESSAGE with a sourceKey caches the finished chat and broadcasts CHAT_DONE", async () => {
		const { chrome, invoke } = await loadBackground();
		chrome.storage.session._data[TAB_STATES_KEY] = {
			7: { status: "page_ready", url: "u", sourceKey: "page:u", tabId: 7 },
		};
		const resp = await invoke({
			type: MSG.CHAT_MESSAGE,
			history: [{ role: "user", text: "Q" }],
			context: { title: "T", summary: "" },
			sourceKey: "page:u",
			tabId: 7,
			bubbles: [{ role: "user", text: "Q" }],
			isSummary: true,
		});
		expect(resp).toEqual({ ok: true, text: "SUMMARY" });

		// The finished conversation is cached by source and patched onto the tab.
		const cached = chrome.storage.session._data.chatsBySource["page:u"];
		expect(cached.history.at(-1)).toEqual({ role: "model", text: "SUMMARY" });
		expect(cached.bubbles.at(-1)).toEqual({ role: "model", text: "SUMMARY" });
		expect(cached.summaryContext.summary).toBe("SUMMARY");
		expect(chrome.storage.session._data[TAB_STATES_KEY][7].chat).toEqual(cached);

		const done = chrome.runtime.sendMessage.mock.calls.find((c) => c[0]?.type === MSG.CHAT_DONE);
		expect(done?.[0]).toMatchObject({ sourceKey: "page:u", ok: true, text: "SUMMARY" });
	});

	it("a finished chat is not patched onto a tab that meanwhile navigated to another source", async () => {
		const { chrome, invoke } = await loadBackground();
		chrome.storage.session._data[TAB_STATES_KEY] = {
			7: { status: "page_ready", url: "other", sourceKey: "page:other", tabId: 7 },
		};
		await invoke({
			type: MSG.CHAT_MESSAGE,
			history: [{ role: "user", text: "Q" }],
			context: {},
			sourceKey: "page:u",
			tabId: 7,
			bubbles: [],
		});
		// Cached by source for when the user comes back…
		expect(chrome.storage.session._data.chatsBySource["page:u"]).toBeTruthy();
		// …but the tab now shows a different page, so its state is untouched.
		expect(chrome.storage.session._data[TAB_STATES_KEY][7].chat).toBeUndefined();
	});

	it("SUMMARY_STATE_REQUEST re-resolving a page attaches its cached chat", async () => {
		const { chrome, invoke, flush } = await loadBackground();
		const url = "https://example.com/a";
		chrome.tabs.query = vi.fn(async () => [{ id: 7, url, status: "complete" }]);
		chrome.scripting.executeScript = vi.fn(async () => [
			{ result: { title: "A", text: "long enough article body text here", url } },
		]);
		const chat = {
			history: [{ role: "user", text: "p" }, { role: "model", text: "CACHED SUMMARY" }],
			bubbles: [{ role: "model", text: "CACHED SUMMARY" }],
			summaryContext: { title: "A", summary: "CACHED SUMMARY" },
		};
		chrome.storage.session._data.chatsBySource = { ["page:" + url]: chat };

		await invoke({ type: MSG.SUMMARY_STATE_REQUEST });
		await flush();
		expect(chrome.storage.session._data[TAB_STATES_KEY][7]).toMatchObject({
			status: "page_ready",
			sourceKey: "page:" + url,
			chat,
		});
	});

	it("SUMMARY_STATE_REQUEST mid-stream attaches pendingChat with the accumulated text", async () => {
		let release;
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(
						`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "PARTIAL" }] } }] })}\n\n`,
					));
					release = () => controller.close();
				},
			}),
		}));
		const { chrome, invoke, flush } = await loadBackground();
		const url = "https://example.com/a";
		chrome.tabs.query = vi.fn(async () => [{ id: 7, url, status: "complete" }]);
		chrome.storage.session._data[TAB_STATES_KEY] = {
			7: { status: "page_ready", url, sourceKey: "page:" + url, tabId: 7 },
		};

		const chatPromise = invoke({
			type: MSG.CHAT_MESSAGE,
			history: [{ role: "user", text: "Q" }],
			context: {},
			sourceKey: "page:" + url,
			tabId: 7,
			bubbles: [{ role: "user", text: "Q" }],
		});
		await flush();
		await flush();

		const resp = await invoke({ type: MSG.SUMMARY_STATE_REQUEST });
		expect(resp.state.pendingChat).toMatchObject({
			accumulated: "PARTIAL",
			bubbles: [{ role: "user", text: "Q" }],
		});

		release();
		const final = await chatPromise;
		expect(final).toEqual({ ok: true, text: "PARTIAL" });
	});

	it("CHAT_STOP with no active chat still responds ok", async () => {
		const { invoke } = await loadBackground();
		const resp = await invoke({ type: MSG.CHAT_STOP });
		expect(resp).toEqual({ ok: true });
	});

	it("setupSidePanel catches errors from sidePanel.setOptions without crashing", async () => {
		vi.resetModules();
		const chrome = makeChrome();
		chrome.sidePanel.setOptions = vi.fn(async () => {
			throw new Error("sidePanel not available");
		});
		chrome.runtime.onMessage.addListener = vi.fn();
		let installedCb;
		chrome.runtime.onInstalled.addListener = vi.fn((cb) => { installedCb = cb; });
		globalThis.chrome = chrome;
		await import("../../src/background.js");
		await expect(installedCb?.()).resolves.toBeUndefined();
	});
});
