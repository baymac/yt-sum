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
