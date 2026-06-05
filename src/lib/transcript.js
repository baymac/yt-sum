// Transcript extraction — the "fast path" of the summarization ladder.
//
// Runs in the content script (isolated world on www.youtube.com), so every
// request below is SAME-ORIGIN and carries the logged-in user's cookies. That
// is the whole reason this works in 2026: YouTube treats it as the genuine WEB
// player and (usually) serves the captions without minting a PO token.
//
//   watch HTML ──parse──▶ ytInitialPlayerResponse ──pick──▶ caption track
//                                                              │
//        ┌─────────────────────────────────────────────────────┘
//        ▼
//   exp=xpe?  ─yes─▶ POT-GATED (isolated world can't mint a token) ─▶ {ok:false}
//        │no
//        ▼
//   GET baseUrl&fmt=json3 ─200+empty─▶ POT-BLOCKED ─▶ {ok:false}
//        │ 200+body
//        ▼
//   concat events[].segs[].utf8 ─▶ {ok:true, text}
//
// A {ok:false} result is NOT a dead end: the caller escalates to the Gemini
// native-video fallback (see src/lib/summarize.js).

/**
 * Pull the first parseable `ytInitialPlayerResponse = {...}` object out of a
 * watch-page HTML string. Uses string-aware brace matching rather than a
 * regex, because the JSON contains `{`/`}`/`"` inside string values.
 *
 * @returns {object|null}
 */
export function extractPlayerResponse(html) {
	if (!html) return null;
	const marker = "ytInitialPlayerResponse";
	let from = 0;
	for (;;) {
		const idx = html.indexOf(marker, from);
		if (idx === -1) return null;
		from = idx + marker.length;
		const eq = html.indexOf("=", idx);
		if (eq === -1) return null;
		// Guard against matching a key like "ytInitialPlayerResponse":"..." far
		// from an assignment; only accept an `=` that's close and precedes a `{`.
		const braceStart = html.indexOf("{", eq);
		if (braceStart === -1) return null;
		if (braceStart - eq > 8) continue; // `=` wasn't the assignment; keep looking
		const json = sliceBalanced(html, braceStart);
		if (json) {
			try {
				return JSON.parse(json);
			} catch (_) {
				/* keep looking for a later, parseable occurrence */
			}
		}
	}
}

// Cap the JSON walk at 2 MB to avoid freezing the content-script main thread
// on pathologically large or adversarially crafted watch-page responses.
const SLICE_SIZE_LIMIT = 2_000_000;

/** Slice a balanced {...} starting at `start`, respecting strings/escapes. */
function sliceBalanced(s, start) {
	if (s.length - start > SLICE_SIZE_LIMIT) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (esc) {
			esc = false;
			continue;
		}
		if (c === "\\") {
			esc = true;
			continue;
		}
		if (c === '"') inStr = !inStr;
		if (inStr) continue;
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * Choose the best caption track. Preference order, per requested languages:
 *   manual[lang] > asr[lang] > (any manual) > first.
 * If the chosen track isn't in the wanted language but is translatable, ask
 * YouTube to machine-translate it via &tlang.
 *
 * @returns {{track:object, translate:boolean, tlang?:string}|null}
 */
export function pickCaptionTrack(tracks, preferredLangs = ["en"]) {
	if (!Array.isArray(tracks) || tracks.length === 0) return null;
	const isAsr = (t) => t.kind === "asr";

	for (const lang of preferredLangs) {
		const manual = tracks.find((t) => t.languageCode === lang && !isAsr(t));
		if (manual) return { track: manual, translate: false };
		const asr = tracks.find((t) => t.languageCode === lang && isAsr(t));
		if (asr) return { track: asr, translate: false };
	}

	const base = tracks.find((t) => !isAsr(t)) || tracks[0];
	const wantLang = preferredLangs[0];
	if (base.languageCode !== wantLang && base.isTranslatable) {
		return { track: base, translate: true, tlang: wantLang };
	}
	return { track: base, translate: false };
}

/**
 * True when a caption baseUrl is gated behind a fresh PO token (exp=xpe). The
 * isolated-world content script can't mint one, so these must skip the direct
 * fetch and go straight to the fallback.
 */
export function isPotGated(baseUrl) {
	if (!baseUrl) return false;
	try {
		const u = new URL(baseUrl, "https://www.youtube.com");
		const exp = u.searchParams.get("exp") || "";
		return exp.split(",").includes("xpe");
	} catch (_) {
		return /[?&]exp=(?:[^&]*,)?xpe(?:,|&|$)/.test(baseUrl);
	}
}

/** Build the timedtext URL: reuse the page-issued baseUrl verbatim, only add fmt/tlang. */
export function buildTimedtextUrl(baseUrl, { fmt = "json3", tlang } = {}) {
	const u = new URL(baseUrl, "https://www.youtube.com");
	if (fmt) u.searchParams.set("fmt", fmt);
	if (tlang) u.searchParams.set("tlang", tlang);
	return u.toString();
}

/** Flatten a json3 timedtext payload into clean continuous text. */
export function parseJson3(data) {
	if (!data || !Array.isArray(data.events)) return "";
	const text = data.events
		.filter((e) => Array.isArray(e.segs))
		.map((e) => e.segs.map((s) => s.utf8 || "").join(""))
		.join(" ");
	return text.replace(/\s+/g, " ").trim();
}

/** Map a failure reason to a short, user-facing explanation. */
export function describeTranscriptFailure(reason) {
	switch (reason) {
		case "no-captions":
			return "This video has no captions.";
		case "pot-gated":
		case "pot-blocked":
			return "YouTube blocked direct caption access for this video.";
		case "not-playable":
			return "This video is restricted (sign-in, age, or members-only).";
		case "no-player-response":
			return "Could not read this video's data from YouTube.";
		default:
			return "Could not fetch the transcript.";
	}
}

/**
 * Fetch and parse the full transcript for a video id. Network-bearing, so it
 * takes an injectable `fetchImpl` for tests.
 *
 * @returns {Promise<{ok:true,text:string,title?:string,lang:string,source:'transcript'}
 *                  | {ok:false,reason:string,title?:string,status?:string,detail?:string}>}
 */
export async function fetchTranscript(videoId, opts = {}) {
	const f = opts.fetchImpl || globalThis.fetch;
	const preferredLangs = opts.preferredLangs || ["en"];

	let html;
	try {
		const res = await f(
			`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`,
			{ credentials: "include" },
		);
		html = await res.text();
	} catch (e) {
		return { ok: false, reason: "fetch-failed", detail: String(e) };
	}

	const pr = extractPlayerResponse(html);
	if (!pr) return { ok: false, reason: "no-player-response" };

	const title = pr?.videoDetails?.title;
	const status = pr?.playabilityStatus?.status;
	if (status && status !== "OK") {
		return { ok: false, reason: "not-playable", status, title };
	}

	const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
	const picked = pickCaptionTrack(tracks, preferredLangs);
	if (!picked || !picked.track.baseUrl) return { ok: false, reason: "no-captions", title };

	if (isPotGated(picked.track.baseUrl)) {
		return { ok: false, reason: "pot-gated", title };
	}

	const url = buildTimedtextUrl(picked.track.baseUrl, {
		fmt: "json3",
		tlang: picked.translate ? picked.tlang : undefined,
	});

	let body;
	try {
		const res = await f(url, { credentials: "include" });
		body = await res.text();
	} catch (e) {
		return { ok: false, reason: "timedtext-failed", detail: String(e), title };
	}

	// HTTP 200 with an empty body is the classic PO-token block — treat it as a
	// transcript miss (escalate to fallback), NOT as "the video has no words".
	if (!body || !body.trim()) return { ok: false, reason: "pot-blocked", title };

	let json;
	try {
		json = JSON.parse(body);
	} catch (_) {
		return { ok: false, reason: "parse-failed", title };
	}

	const text = parseJson3(json);
	if (!text) return { ok: false, reason: "empty-transcript", title };

	return {
		ok: true,
		text,
		title,
		lang: picked.track.languageCode,
		source: "transcript",
	};
}
