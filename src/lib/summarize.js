// Gemini summarization — runs in the background service worker so the API key
// never enters page/content-script context.
//
// Two modes, chosen by the caller:
//   mode 'transcript' — we already have the words → send them as text (cheap,
//                       fast, fits 1M ctx, not subject to the 8h/day video cap).
//   mode 'video'      — transcript unavailable (pot-gated / no captions) → hand
//                       Gemini the YouTube URL as fileData.fileUri and let it
//                       watch the video natively. Public videos only.

export const GEMINI_MODEL = "gemini-2.5-flash";
const ENDPOINT = (model) =>
	`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const STREAM_ENDPOINT = (model) =>
	`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

// Keep a long transcript comfortably under the free-tier 250K TPM ceiling while
// still covering multi-hour videos (~200K chars ≈ 50K tokens).
const MAX_TRANSCRIPT_CHARS = 200000;

const SUMMARY_INSTRUCTION = `You are summarizing a YouTube video so the reader does NOT have to watch it. Produce a clear, well-structured Markdown summary with these sections:

## TL;DR
2-3 sentences capturing the core message.

## Key Points
A bulleted list of the main points, arguments, or steps in the order they appear. Be specific — include the concrete facts, numbers, names, and conclusions, not vague descriptions.

## Details
A few short paragraphs walking through the substance so the reader gets everything important without watching.

## Takeaways
The most useful insights or action items.

Write in plain, direct language. Do not invent content that isn't supported by the source.`;

/** Clamp a transcript and note if it was truncated. */
export function clampTranscript(text, max = MAX_TRANSCRIPT_CHARS) {
	if (!text) return "";
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[transcript truncated for length]`;
}

/** Build the user-facing prompt for transcript mode. */
export function buildTranscriptPrompt({ title, transcript }) {
	const head = title ? `Video title: ${title}\n\n` : "";
	return `${SUMMARY_INSTRUCTION}\n\n${head}TRANSCRIPT:\n${clampTranscript(transcript)}`;
}

const GENERATION_CONFIG = { temperature: 0.3, maxOutputTokens: 8192 };

/** Build the generateContent request body for either mode. */
export function buildRequestBody({ mode, title, transcript, videoUrl }) {
	if (mode === "video") {
		const ask = title
			? `${SUMMARY_INSTRUCTION}\n\nThe video title is: ${title}`
			: SUMMARY_INSTRUCTION;
		return {
			contents: [
				{
					role: "user",
					parts: [{ text: ask }, { file_data: { file_uri: videoUrl } }],
				},
			],
			generationConfig: GENERATION_CONFIG,
		};
	}
	return {
		contents: [
			{
				role: "user",
				parts: [{ text: buildTranscriptPrompt({ title, transcript }) }],
			},
		],
		generationConfig: GENERATION_CONFIG,
	};
}

/** Pull the summary text out of a generateContent response, or null. */
export function parseGeminiResponse(data) {
	const parts = data?.candidates?.[0]?.content?.parts;
	if (Array.isArray(parts)) {
		const text = parts
			.map((p) => p.text || "")
			.join("")
			.trim();
		if (text) return text;
	}
	return null;
}

// Only retry on the status codes that are actually transient. (An earlier
// version also matched "try again"/"temporarily" in the message, which wrongly
// retried permanent 4xx errors whose text happened to contain those words.)
const isTransient = (status) => status === 429 || status >= 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST to Gemini with retry/backoff on transient (429/503/500/overloaded)
 * errors. Returns {ok:true,text} or {ok:false,error}.
 */
export async function callGemini({
	apiKey,
	model = GEMINI_MODEL,
	body,
	fetchImpl,
	sleepImpl = sleep,
	maxAttempts = 3,
}) {
	const f = fetchImpl || globalThis.fetch;
	let lastError = "Request failed.";

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) await sleepImpl(2 ** (attempt - 1) * 1000); // 1s, 2s

		let res;
		try {
			res = await f(ENDPOINT(model), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-goog-api-key": apiKey,
				},
				body: JSON.stringify(body),
			});
		} catch (e) {
			lastError = `Network error: ${e?.message || e}`;
			continue; // network blip — retry
		}

		if (res.ok) {
			const data = await res.json().catch(() => null);
			const text = parseGeminiResponse(data);
			if (text) return { ok: true, text };
			return {
				ok: false,
				error:
					"Gemini returned no summary (the response may have been blocked or empty).",
			};
		}

		const errData = await res.json().catch(() => ({}));
		const message = errData?.error?.message || res.statusText || "API error";
		if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(message)) {
			return { ok: false, error: "Your Gemini API key is invalid. Update it in the side panel settings." };
		}
		if (!isTransient(res.status)) {
			return { ok: false, error: message };
		}
		lastError = message;
	}

	return { ok: false, error: `Gemini is busy right now. ${lastError}` };
}

/**
 * Streaming variant: calls streamGenerateContent?alt=sse and invokes onChunk
 * with the accumulated text after each SSE event. Returns the final full text.
 * Throws on non-retried errors; retries on transient (429/5xx) up to maxAttempts.
 */
export async function callGeminiStreaming({
	apiKey,
	model = GEMINI_MODEL,
	body,
	onChunk,
	fetchImpl,
	sleepImpl = sleep,
	maxAttempts = 3,
}) {
	const f = fetchImpl || globalThis.fetch;
	let lastError = "Request failed.";

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) await sleepImpl(2 ** (attempt - 1) * 1000);

		let res;
		try {
			res = await f(STREAM_ENDPOINT(model), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-goog-api-key": apiKey,
				},
				body: JSON.stringify(body),
			});
		} catch (e) {
			lastError = `Network error: ${e?.message || e}`;
			continue;
		}

		if (!res.ok) {
			const errData = await res.json().catch(() => ({}));
			const message = errData?.error?.message || res.statusText || "API error";
			if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(message)) {
				throw new Error("Your Gemini API key is invalid. Update it in the side panel settings.");
			}
			if (!isTransient(res.status)) throw new Error(message);
			lastError = message;
			continue;
		}

		// Parse SSE stream and accumulate text.
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let accumulated = "";
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6).trim();
				if (!data || data === "[DONE]") continue;
				try {
					const json = JSON.parse(data);
					const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
					if (text) {
						accumulated += text;
						onChunk?.(accumulated);
					}
				} catch (_) {}
			}
		}

		return accumulated;
	}

	throw new Error(`Gemini is busy right now. ${lastError}`);
}

/**
 * High-level entry: pick the mode from whether a transcript is present, then
 * call Gemini.
 *
 * @returns {Promise<{ok:true,text:string,mode:'transcript'|'video'}
 *                  | {ok:false,error:string}>}
 */
export async function summarize({
	apiKey,
	videoUrl,
	title,
	transcript,
	model = GEMINI_MODEL,
	fetchImpl,
	sleepImpl,
}) {
	if (!apiKey) {
		return { ok: false, error: "Set your Gemini API key in the side panel first." };
	}
	const mode = transcript && transcript.trim() ? "transcript" : "video";
	const body = buildRequestBody({ mode, title, transcript, videoUrl });
	const result = await callGemini({ apiKey, model, body, fetchImpl, sleepImpl });
	if (result.ok) return { ok: true, text: result.text, mode };
	return result;
}
