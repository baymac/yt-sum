import { describe, it, expect, vi } from "vitest";
import {
	clampTranscript,
	buildTranscriptPrompt,
	buildRequestBody,
	parseGeminiResponse,
	callGemini,
	buildOpenRouterRequestBody,
	callOpenRouterStreaming,
	summarize,
} from "../../src/lib/summarize.js";

const okResponse = (text) => ({
	ok: true,
	status: 200,
	json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
});
const errResponse = (status, message) => ({
	ok: false,
	status,
	statusText: "err",
	json: async () => ({ error: { message } }),
});
const noSleep = async () => {};

describe("clampTranscript", () => {
	it("leaves short transcripts intact", () => {
		expect(clampTranscript("hello")).toBe("hello");
	});
	it("truncates long transcripts with a note", () => {
		const out = clampTranscript("x".repeat(10), 5);
		expect(out.startsWith("xxxxx")).toBe(true);
		expect(out).toContain("[transcript truncated for length]");
	});
});

describe("buildTranscriptPrompt / buildRequestBody", () => {
	it("includes title, instruction, and transcript", () => {
		const p = buildTranscriptPrompt({ title: "My Vid", transcript: "the words" });
		expect(p).toContain("My Vid");
		expect(p).toContain("TRANSCRIPT:");
		expect(p).toContain("the words");
		expect(p).toContain("## TL;DR");
	});
	it("omits the title header when title is empty or undefined", () => {
		const p = buildTranscriptPrompt({ title: "", transcript: "words" });
		expect(p).not.toContain("Video title:");
		expect(p).toContain("TRANSCRIPT:");
		const p2 = buildTranscriptPrompt({ title: undefined, transcript: "words" });
		expect(p2).not.toContain("Video title:");
	});
	it("builds a transcript-mode body with a single text part", () => {
		const body = buildRequestBody({ mode: "transcript", title: "T", transcript: "words" });
		expect(body.contents[0].parts).toHaveLength(1);
		expect(body.contents[0].parts[0].text).toContain("words");
	});
	it("builds a video-mode body with a file_data part", () => {
		const body = buildRequestBody({ mode: "video", title: "T", videoUrl: "https://youtu.be/x" });
		const fileDataPart = body.contents[0].parts.find((p) => p.file_data);
		expect(fileDataPart.file_data.file_uri).toBe("https://youtu.be/x");
	});
});

describe("parseGeminiResponse", () => {
	it("joins text parts", () => {
		expect(parseGeminiResponse({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] })).toBe("ab");
	});
	it("returns null when blocked or empty", () => {
		expect(parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } })).toBeNull();
		expect(parseGeminiResponse({})).toBeNull();
	});
});

describe("OpenRouter", () => {
	it("converts Gemini-style transcript contents to chat-completions messages", () => {
		const body = buildOpenRouterRequestBody({
			model: "anthropic/claude-3.5-sonnet",
			body: {
				contents: [
					{ role: "user", parts: [{ text: "Question" }] },
					{ role: "model", parts: [{ text: "Answer" }] },
				],
				generationConfig: { temperature: 0.5, maxOutputTokens: 99 },
			},
		});
		expect(body).toMatchObject({
			model: "anthropic/claude-3.5-sonnet",
			messages: [
				{ role: "user", content: "Question" },
				{ role: "assistant", content: "Answer" },
			],
			temperature: 0.5,
			max_tokens: 99,
			stream: true,
		});
	});

	it("streams OpenRouter content with a bearer key", async () => {
		const chunk = new TextEncoder().encode(
			`data: ${JSON.stringify({ choices: [{ delta: { content: "SUMMARY" } }] })}\n\ndata: [DONE]\n\n`,
		);
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			body: new ReadableStream({ start(controller) { controller.enqueue(chunk); controller.close(); } }),
		}));
		const text = await callOpenRouterStreaming({
			apiKey: "or-key",
			model: "meta-llama/llama-3.1-8b-instruct",
			body: { contents: [{ role: "user", parts: [{ text: "Summarize" }] }] },
			fetchImpl,
		});
		expect(text).toBe("SUMMARY");
		expect(fetchImpl.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer or-key");
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
			model: "meta-llama/llama-3.1-8b-instruct",
			messages: [{ role: "user", content: "Summarize" }],
		});
	});

	it("rejects the Gemini-only video fallback", () => {
		expect(() =>
			buildOpenRouterRequestBody({
				body: buildRequestBody({ mode: "video", videoUrl: "https://youtu.be/x" }),
			}),
		).toThrow(/video fallback/i);
	});
});

describe("callGemini", () => {
	it("returns text on success", async () => {
		const fetchImpl = vi.fn(async () => okResponse("SUMMARY"));
		const res = await callGemini({ apiKey: "k", body: {}, fetchImpl, sleepImpl: noSleep });
		expect(res).toEqual({ ok: true, text: "SUMMARY" });
		// API key goes in the header, not the URL.
		expect(fetchImpl.mock.calls[0][1].headers["x-goog-api-key"]).toBe("k");
		expect(fetchImpl.mock.calls[0][0]).not.toContain("key=");
	});
	it("retries on 429 then succeeds", async () => {
		let n = 0;
		const fetchImpl = vi.fn(async () => (++n < 2 ? errResponse(429, "rate limit") : okResponse("OK")));
		const res = await callGemini({ apiKey: "k", body: {}, fetchImpl, sleepImpl: noSleep });
		expect(res.ok).toBe(true);
		expect(n).toBe(2);
	});
	it("maps an invalid key to a helpful message", async () => {
		const fetchImpl = async () => errResponse(400, "API key not valid. Please pass a valid API key.");
		const res = await callGemini({ apiKey: "bad", body: {}, fetchImpl, sleepImpl: noSleep });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/invalid/i);
	});
	it("fails fast on a non-transient error", async () => {
		const fetchImpl = vi.fn(async () => errResponse(403, "permission denied"));
		const res = await callGemini({ apiKey: "k", body: {}, fetchImpl, sleepImpl: noSleep });
		expect(res.ok).toBe(false);
		expect(res.error).toBe("permission denied");
		expect(fetchImpl).toHaveBeenCalledTimes(1); // no retries
	});
	it("gives up after repeated transient errors", async () => {
		const fetchImpl = vi.fn(async () => errResponse(503, "overloaded"));
		const res = await callGemini({ apiKey: "k", body: {}, fetchImpl, sleepImpl: noSleep, maxAttempts: 3 });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/busy/i);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});
	it("retries after a network throw and succeeds on the next attempt", async () => {
		let n = 0;
		const fetchImpl = vi.fn(async () => {
			n++;
			if (n === 1) throw new Error("network blip");
			return okResponse("RECOVERED");
		});
		const res = await callGemini({ apiKey: "k", body: {}, fetchImpl, sleepImpl: noSleep });
		expect(res.ok).toBe(true);
		expect(res.text).toBe("RECOVERED");
		expect(n).toBe(2);
	});
});

describe("summarize", () => {
	it("uses transcript mode when a transcript is present", async () => {
		const fetchImpl = vi.fn(async () => okResponse("S"));
		const res = await summarize({ apiKey: "k", title: "T", transcript: "words", fetchImpl, sleepImpl: noSleep });
		expect(res).toEqual({ ok: true, text: "S", mode: "transcript" });
		const sentBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
		expect(sentBody.contents[0].parts[0].text).toContain("words");
	});
	it("falls back to video mode when no transcript", async () => {
		const fetchImpl = vi.fn(async () => okResponse("S"));
		const res = await summarize({ apiKey: "k", videoUrl: "https://youtu.be/x", transcript: null, fetchImpl, sleepImpl: noSleep });
		expect(res.mode).toBe("video");
		const sentBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
		expect(sentBody.contents[0].parts.some((p) => p.file_data)).toBe(true);
	});
	it("errors when no API key is set", async () => {
		const res = await summarize({ apiKey: "", transcript: "x" });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/api key/i);
	});
});
