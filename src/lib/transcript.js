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
	// Scan at most SLICE_SIZE_LIMIT bytes from `start` — don't bail just because
	// the rest of the page is large (YouTube pages are routinely 4–6 MB in 2026).
	const end = Math.min(s.length, start + SLICE_SIZE_LIMIT);
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < end; i++) {
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

// ── InnerTube player fallback (un-gated captions) ────────────────────────────
//
// When the WEB client's timedtext is POT-gated (200 + empty body), the
// `web_creator` / `tv` InnerTube clients return a *different*, server-signed
// caption baseUrl with no `exp=xpe` flag — the same URL yt-dlp uses. Those
// clients require sign-in, so we mint the `SAPISIDHASH` Authorization header
// YouTube itself sends, computed from the SAPISID cookie (readable from the
// content script — it isn't HttpOnly). Algorithm mirrors yt-dlp's
// _make_sid_authorization / generate_api_headers exactly.
//
//   watch HTML ──parse ytcfg──▶ {apiKey, visitorData}
//        │
//        └─ POST youtubei/v1/player {web_creator|tv context} + SAPISIDHASH auth
//                 └─▶ captionTracks[].baseUrl (signed, un-gated) ──▶ json3 text

const ORIGIN = "https://www.youtube.com";

// Player clients that return un-gated caption URLs, tried in order. Versions
// track yt-dlp's INNERTUBE_CLIENTS (see yt_dlp/extractor/youtube/_base.py).
const INNERTUBE_PLAYER_CLIENTS = [
	{ clientName: "WEB_CREATOR", clientNum: 62, version: "1.20260114.05.00" },
	{ clientName: "TVHTML5", clientNum: 7, version: "7.20260114.12.00" },
];

/** Parse a `document.cookie` string into a name→value map. */
export function parseCookies(str) {
	const out = {};
	for (const part of (str || "").split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}

/** SHA-1 hex digest via Web Crypto (available in the content script + SW). */
async function sha1Hex(str) {
	const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Build YouTube's `Authorization: SAPISIDHASH …` header from session cookies.
 * Returns null when no auth cookie is present (logged-out → can't use these
 * clients). Mirrors yt-dlp: `<scheme> <ts>_<sha1(ts + " " + sid + " " + origin)>`,
 * one part per SAPISID / 1P / 3P cookie, space-joined.
 */
export async function makeSidAuthorization(cookieStr, now = Date.now()) {
	const c = parseCookies(cookieStr);
	const sapisid = c.SAPISID || c["__Secure-3PAPISID"];
	const ts = Math.floor(now / 1000).toString();
	const parts = [];
	for (const [scheme, sid] of [
		["SAPISIDHASH", sapisid],
		["SAPISID1PHASH", c["__Secure-1PAPISID"]],
		["SAPISID3PHASH", c["__Secure-3PAPISID"]],
	]) {
		if (!sid) continue;
		parts.push(`${scheme} ${ts}_${await sha1Hex(`${ts} ${sid} ${ORIGIN}`)}`);
	}
	return parts.length ? parts.join(" ") : null;
}

/** Pull the InnerTube client config out of a watch-page HTML string. */
export function parseInnertubeConfig(html) {
	if (!html) return null;
	const apiKey = html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/)?.[1];
	const visitorData =
		html.match(/"visitorData":\s*"([^"]+)"/)?.[1] ||
		html.match(/"VISITOR_DATA":\s*"([^"]+)"/)?.[1] ||
		undefined;
	if (!apiKey) return null;
	return { apiKey, visitorData };
}

/**
 * Recover a transcript when timedtext is POT-gated, by asking the `web_creator`
 * / `tv` InnerTube player clients for an un-gated caption URL. Fully defensive:
 * any failure (no auth, network, parse, missing fields) resolves to null so the
 * caller falls through to the Gemini video fallback.
 */
async function fetchInnertubeTranscript({ f, videoId, html, cookieStr, preferredLangs, dbg }) {
	const cfg = parseInnertubeConfig(html);
	if (!cfg) {
		dbg("innertube: no INNERTUBE_API_KEY in page — skipping");
		return null;
	}
	const auth = await makeSidAuthorization(cookieStr).catch(() => null);
	if (!auth) {
		dbg("innertube: no SAPISID cookie — not signed in, can't use web_creator/tv");
		return null;
	}
	dbg("innertube: auth header built, visitorData:", cfg.visitorData ? "yes" : "no");

	for (const client of INNERTUBE_PLAYER_CLIENTS) {
		try {
			const text = await fetchPlayerCaptions({ f, videoId, cfg, auth, client, preferredLangs, dbg });
			if (text) return text;
		} catch (e) {
			dbg(`innertube ${client.clientName}: failed —`, String(e));
		}
	}
	return null;
}

/** One client attempt: POST player → pick caption track → fetch json3 → text. */
async function fetchPlayerCaptions({ f, videoId, cfg, auth, client, preferredLangs, dbg }) {
	const res = await f(`https://www.youtube.com/youtubei/v1/player?key=${cfg.apiKey}&prettyPrint=false`, {
		method: "POST",
		credentials: "include",
		headers: {
			"Content-Type": "application/json",
			Authorization: auth,
			"X-Origin": ORIGIN,
			"X-Goog-AuthUser": "0",
			"X-Youtube-Client-Name": String(client.clientNum),
			"X-Youtube-Client-Version": client.version,
			...(cfg.visitorData ? { "X-Goog-Visitor-Id": cfg.visitorData } : {}),
		},
		body: JSON.stringify({
			context: {
				client: {
					clientName: client.clientName,
					clientVersion: client.version,
					hl: "en",
					...(cfg.visitorData ? { visitorData: cfg.visitorData } : {}),
				},
			},
			videoId,
		}),
	});
	const pr = JSON.parse(await res.text());
	const status = pr?.playabilityStatus?.status;
	const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
	dbg(`innertube ${client.clientName}: status`, status, "caption tracks", tracks?.length ?? 0);

	const picked = pickCaptionTrack(tracks, preferredLangs);
	if (!picked?.track?.baseUrl) return null;
	const gated = isPotGated(picked.track.baseUrl);
	dbg(`innertube ${client.clientName}: caption baseUrl gated?`, gated);

	const url = buildTimedtextUrl(picked.track.baseUrl, {
		fmt: "json3",
		tlang: picked.translate ? picked.tlang : undefined,
	});
	const tr = await f(url, { credentials: "include" });
	const body = await tr.text();
	dbg(`innertube ${client.clientName}: timedtext status`, tr.status, "body length", body.length);
	if (!body || !body.trim()) return null;
	const text = parseJson3(JSON.parse(body));
	return text || null;
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
	const cookieStr = opts.cookieStr ?? (typeof document !== "undefined" ? document.cookie : "");
	const dbg = (...a) => console.log("[YT-SUM transcript]", ...a);

	dbg("start", { videoId, preferredLangs });

	let html;
	try {
		const res = await f(
			`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`,
			{ credentials: "include" },
		);
		dbg("watch-page fetch", res.status, res.url, "html length will follow");
		html = await res.text();
		dbg("watch-page html length:", html.length, "bytes");
	} catch (e) {
		dbg("FAIL fetch-failed", e);
		return { ok: false, reason: "fetch-failed", detail: String(e) };
	}

	// Log where ytInitialPlayerResponse appears in the page
	const markerIdx = html.indexOf("ytInitialPlayerResponse");
	dbg("ytInitialPlayerResponse marker at index:", markerIdx, "(of", html.length, ")");

	const pr = extractPlayerResponse(html);
	dbg("extractPlayerResponse result:", pr ? "OK" : "NULL");
	if (!pr) {
		dbg("FAIL no-player-response — marker was at", markerIdx, "page length", html.length);
		return { ok: false, reason: "no-player-response" };
	}

	const title = pr?.videoDetails?.title;
	const status = pr?.playabilityStatus?.status;
	dbg("playabilityStatus:", status, "title:", title);
	if (status && status !== "OK") {
		dbg("FAIL not-playable, status:", status);
		return { ok: false, reason: "not-playable", status, title };
	}

	const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
	dbg("caption tracks found:", tracks?.length ?? 0, tracks?.map(t => `${t.languageCode}(${t.kind || "manual"})`));
	const picked = pickCaptionTrack(tracks, preferredLangs);
	dbg("pickCaptionTrack result:", picked ? { lang: picked.track.languageCode, kind: picked.track.kind, translate: picked.translate } : "NULL");
	if (!picked || !picked.track.baseUrl) {
		dbg("FAIL no-captions");
		return { ok: false, reason: "no-captions", title };
	}

	const potGated = isPotGated(picked.track.baseUrl);
	dbg("isPotGated:", potGated, "baseUrl (first 120):", picked.track.baseUrl.slice(0, 120));
	// Don't bail early on pot-gated — try the URL anyway; same-origin session
	// cookies often bypass the POT check for logged-in users.

	const url = buildTimedtextUrl(picked.track.baseUrl, {
		fmt: "json3",
		tlang: picked.translate ? picked.tlang : undefined,
	});
	dbg("fetching timedtext url (first 120):", url.slice(0, 120));

	let body;
	try {
		const res = await f(url, { credentials: "include" });
		dbg("timedtext fetch status:", res.status);
		body = await res.text();
		dbg("timedtext body length:", body.length, "first 200 chars:", body.slice(0, 200));
	} catch (e) {
		dbg("FAIL timedtext-failed", e);
		return { ok: false, reason: "timedtext-failed", detail: String(e), title };
	}

	// If the server rejected the request (empty body), try a simplified timedtext
	// URL without the server-generated params — these don't carry the exp=xpe flag
	// and often work for logged-in users' ASR tracks.
	if ((!body || !body.trim()) && potGated) {
		const simpleLang = picked.track.languageCode;
		const simpleUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(simpleLang)}&fmt=json3`;
		dbg("pot-blocked — trying simplified timedtext fallback:", simpleUrl);
		try {
			const sr = await f(simpleUrl, { credentials: "include" });
			const sb = await sr.text();
			dbg("simplified timedtext status:", sr.status, "body length:", sb.length, "first 200:", sb.slice(0, 200));
			if (sb && sb.trim()) body = sb;
		} catch (e) {
			dbg("simplified timedtext fallback threw:", e);
		}
	}

	// Both timedtext attempts came back empty — POT-gated. Last resort: the
	// InnerTube get_transcript API, which the WEB player uses for its own
	// "Show transcript" panel and isn't POT-gated.
	if (!body || !body.trim()) {
		dbg("timedtext exhausted — trying InnerTube player (web_creator/tv) fallback");
		const itText = await fetchInnertubeTranscript({ f, videoId, html, cookieStr, preferredLangs, dbg });
		if (itText) {
			dbg("SUCCESS via InnerTube, text length:", itText.length);
			return { ok: true, text: itText, title, lang: picked.track.languageCode, source: "innertube" };
		}
	}

	if (!body || !body.trim()) {
		dbg("FAIL pot-blocked — empty body (all attempts exhausted)");
		return { ok: false, reason: "pot-blocked", title };
	}

	let json;
	try {
		json = JSON.parse(body);
		dbg("JSON parse OK, events count:", json?.events?.length);
	} catch (e) {
		dbg("FAIL parse-failed", e, "body snippet:", body.slice(0, 200));
		return { ok: false, reason: "parse-failed", title };
	}

	const text = parseJson3(json);
	dbg("parseJson3 text length:", text.length, "snippet:", text.slice(0, 100));
	if (!text) {
		dbg("FAIL empty-transcript");
		return { ok: false, reason: "empty-transcript", title };
	}

	dbg("SUCCESS lang:", picked.track.languageCode, "text length:", text.length);
	return {
		ok: true,
		text,
		title,
		lang: picked.track.languageCode,
		source: "transcript",
	};
}
