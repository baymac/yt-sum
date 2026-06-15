import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeChrome } from "../setup.js";
import { MSG, SESSION_KEY } from "../../src/lib/messages.js";

// Load background.js fresh with a chrome mock whose onMessage.addListener we
// capture, so we can drive the message hub directly.
async function loadBackground(initial = { geminiApiKey: "k" }) {
	vi.resetModules();
	let listener;
	const chrome = makeChrome(initial);
	chrome.runtime.onMessage.addListener = vi.fn((cb) => {
		listener = cb;
	});
	globalThis.chrome = chrome;
	await import("../../src/background.js");
	const invoke = (msg, sender = {}) =>
		new Promise((resolve) => {
			const isAsync = listener(msg, sender, resolve);
			if (isAsync !== true) resolve(undefined);
		});
	const flush = () => new Promise((r) => setTimeout(r, 0));
	return { chrome, invoke, flush };
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

	it("PUBLISH_SUMMARY stores session state and broadcasts SUMMARY_READY", async () => {
		const { chrome, invoke, flush } = await loadBackground();
		const payload = { status: "done", videoId: "abc", title: "T", text: "S", mode: "transcript" };
		await invoke({ type: MSG.PUBLISH_SUMMARY, payload });
		await flush();
		expect(chrome.storage.session._data[SESSION_KEY]).toEqual(payload);
		const broadcast = chrome.runtime.sendMessage.mock.calls.find(
			(c) => c[0]?.type === MSG.SUMMARY_READY,
		);
		expect(broadcast?.[0].state).toEqual(payload);
	});

	it("SUMMARY_STATE_REQUEST returns the stored state", async () => {
		const { chrome, invoke } = await loadBackground();
		const state = { status: "done", videoId: "z", text: "S" };
		chrome.storage.session._data[SESSION_KEY] = state;
		const resp = await invoke({ type: MSG.SUMMARY_STATE_REQUEST });
		expect(resp).toEqual({ ok: true, state });
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
