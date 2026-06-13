import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	extractPlayerResponse,
	pickCaptionTrack,
	isPotGated,
	buildTimedtextUrl,
	parseJson3,
	fetchTranscript,
	describeTranscriptFailure,
	parseInnertubeConfig,
	parseCookies,
	makeSidAuthorization,
} from "../../src/lib/transcript.js";

const fixture = (name) =>
	readFileSync(join(process.cwd(), "tests", "fixtures", name), "utf8");

const realWatchHtml = fixture("watch-with-captions.html");
const realJson3 = JSON.parse(fixture("transcript.json3.json"));

// Helper: wrap a player response object as a watch-page <script> the way YouTube does.
const watchHtml = (pr) =>
	`<!DOCTYPE html><html><body><script>var ytInitialPlayerResponse = ${JSON.stringify(pr)};</script></body></html>`;

const track = (over = {}) => ({
	baseUrl: "https://www.youtube.com/api/timedtext?v=ID&lang=en",
	languageCode: "en",
	...over,
});

describe("extractPlayerResponse", () => {
	it("parses the real captured watch fixture", () => {
		const pr = extractPlayerResponse(realWatchHtml);
		expect(pr).toBeTruthy();
		expect(pr.captions.playerCaptionsTracklistRenderer.captionTracks.length).toBe(6);
		expect(pr.videoDetails.title).toContain("Never Gonna Give You Up");
	});
	it("handles braces and quotes inside string values", () => {
		const html = watchHtml({ videoDetails: { title: 'a {b} "c" \\}' }, captions: null });
		const pr = extractPlayerResponse(html);
		expect(pr.videoDetails.title).toBe('a {b} "c" \\}');
	});
	it("returns null when no player response is present", () => {
		expect(extractPlayerResponse("<html><body>no data</body></html>")).toBeNull();
		expect(extractPlayerResponse("")).toBeNull();
	});
});

describe("pickCaptionTrack", () => {
	it("prefers a manual track in the wanted language", () => {
		const picked = pickCaptionTrack([
			track({ languageCode: "en", kind: "asr" }),
			track({ languageCode: "en" }),
		]);
		expect(picked.track.kind).toBeUndefined();
		expect(picked.translate).toBe(false);
	});
	it("falls back to the ASR track in the wanted language", () => {
		const picked = pickCaptionTrack([
			track({ languageCode: "de" }),
			track({ languageCode: "en", kind: "asr" }),
		]);
		expect(picked.track.languageCode).toBe("en");
		expect(picked.track.kind).toBe("asr");
	});
	it("requests translation when only another language exists and is translatable", () => {
		const picked = pickCaptionTrack([track({ languageCode: "de", isTranslatable: true })]);
		expect(picked.translate).toBe(true);
		expect(picked.tlang).toBe("en");
	});
	it("returns null for empty/undefined", () => {
		expect(pickCaptionTrack([])).toBeNull();
		expect(pickCaptionTrack(undefined)).toBeNull();
	});
	it("selects a usable track from the real fixture (manual en)", () => {
		const tracks = extractPlayerResponse(realWatchHtml).captions
			.playerCaptionsTracklistRenderer.captionTracks;
		const picked = pickCaptionTrack(tracks);
		expect(picked.track.languageCode).toBe("en");
		expect(picked.track.kind).toBeUndefined(); // manual preferred over the asr track
	});
});

describe("isPotGated", () => {
	it("detects exp=xpe", () => {
		expect(isPotGated("https://x/api/timedtext?v=ID&exp=xpe&hl=en")).toBe(true);
		expect(isPotGated("https://x/api/timedtext?v=ID&exp=9405,xpe&hl=en")).toBe(true);
	});
	it("is false without the marker", () => {
		expect(isPotGated("https://x/api/timedtext?v=ID&hl=en")).toBe(false);
		expect(isPotGated("https://x/api/timedtext?v=ID&exp=other")).toBe(false);
	});
	it("flags the real fixture's baseUrl as pot-gated", () => {
		const tracks = extractPlayerResponse(realWatchHtml).captions
			.playerCaptionsTracklistRenderer.captionTracks;
		expect(isPotGated(tracks[0].baseUrl)).toBe(true);
	});
});

describe("describeTranscriptFailure", () => {
	it("maps reasons to user-facing messages", () => {
		expect(describeTranscriptFailure("no-captions")).toMatch(/no captions/i);
		expect(describeTranscriptFailure("not-playable")).toMatch(/restricted/i);
		expect(describeTranscriptFailure("pot-gated")).toMatch(/blocked/i);
		expect(describeTranscriptFailure("anything-else")).toMatch(/could not/i);
	});
});

describe("parseInnertubeConfig", () => {
	it("extracts apiKey and visitorData from page HTML", () => {
		const html = `<script>ytcfg.set({"INNERTUBE_API_KEY":"AIzaTESTKEY","VISITOR_DATA":"VD123"});</script>`;
		const cfg = parseInnertubeConfig(html);
		expect(cfg.apiKey).toBe("AIzaTESTKEY");
		expect(cfg.visitorData).toBe("VD123");
	});
	it("returns null when no API key is present", () => {
		expect(parseInnertubeConfig("<html></html>")).toBeNull();
	});
});

describe("parseCookies", () => {
	it("parses a document.cookie string into a name→value map", () => {
		const c = parseCookies("SAPISID=abc; __Secure-3PAPISID=def; PREF=tz=Asia");
		expect(c.SAPISID).toBe("abc");
		expect(c["__Secure-3PAPISID"]).toBe("def");
		// only splits on the first '=' so values containing '=' survive
		expect(c.PREF).toBe("tz=Asia");
	});
	it("returns an empty map for empty input", () => {
		expect(parseCookies("")).toEqual({});
	});
});

describe("makeSidAuthorization", () => {
	it("builds SAPISIDHASH/1P/3P parts with sha1(ts SP sid SP origin)", async () => {
		// now = 1_000_000 ms → ts = 1000
		const auth = await makeSidAuthorization(
			"SAPISID=sap; __Secure-1PAPISID=p1; __Secure-3PAPISID=p3",
			1_000_000,
		);
		expect(auth).toMatch(/^SAPISIDHASH 1000_[0-9a-f]{40} SAPISID1PHASH 1000_[0-9a-f]{40} SAPISID3PHASH 1000_[0-9a-f]{40}$/);
	});
	it("falls back to __Secure-3PAPISID when SAPISID is absent", async () => {
		const auth = await makeSidAuthorization("__Secure-3PAPISID=p3", 0);
		expect(auth).toMatch(/^SAPISIDHASH 0_[0-9a-f]{40} SAPISID3PHASH 0_[0-9a-f]{40}$/);
	});
	it("returns null when no auth cookie is present (logged out)", async () => {
		expect(await makeSidAuthorization("PREF=x; YSC=y")).toBeNull();
	});
});

describe("buildTimedtextUrl", () => {
	it("adds fmt=json3 and preserves existing params", () => {
		const url = buildTimedtextUrl("https://www.youtube.com/api/timedtext?v=ID&lang=en");
		expect(url).toContain("fmt=json3");
		expect(url).toContain("v=ID");
		expect(url).toContain("lang=en");
	});
	it("adds tlang when translating", () => {
		const url = buildTimedtextUrl("https://www.youtube.com/api/timedtext?v=ID", { tlang: "en" });
		expect(url).toContain("tlang=en");
	});
});

describe("parseJson3", () => {
	it("concatenates segments and collapses whitespace", () => {
		const text = parseJson3(realJson3);
		expect(text).toContain("We're no strangers to love");
		expect(text).toContain("the rules and so do I");
		expect(text).not.toMatch(/\s{2,}/);
	});
	it("skips events without segs and handles empties", () => {
		expect(parseJson3({ events: [{ tStartMs: 0 }, { segs: [{ utf8: "hi" }] }] })).toBe("hi");
		expect(parseJson3({})).toBe("");
		expect(parseJson3(null)).toBe("");
	});
});

describe("fetchTranscript", () => {
	// Build a fetch that serves a watch HTML and a timedtext body by URL.
	function makeFetch({ html, timedtext, timedtextStatus = 200 }) {
		return async (url) => {
			if (url.includes("/watch")) return { ok: true, status: 200, text: async () => html };
			if (url.includes("timedtext"))
				return { ok: true, status: timedtextStatus, text: async () => timedtext };
			throw new Error(`unexpected url ${url}`);
		};
	}

	const okPlayer = {
		videoDetails: { videoId: "ID", title: "Test Video" },
		playabilityStatus: { status: "OK" },
		captions: {
			playerCaptionsTracklistRenderer: {
				captionTracks: [track({ baseUrl: "https://www.youtube.com/api/timedtext?v=ID&lang=en" })],
			},
		},
	};

	it("returns transcript text on the happy path", async () => {
		const res = await fetchTranscript("ID", {
			fetchImpl: makeFetch({ html: watchHtml(okPlayer), timedtext: JSON.stringify(realJson3) }),
		});
		expect(res.ok).toBe(true);
		expect(res.source).toBe("transcript");
		expect(res.text).toContain("We're no strangers");
		expect(res.title).toBe("Test Video");
	});

	it("still attempts the fetch when pot-gated (exp=xpe) — cookies often bypass POT", async () => {
		let timedtextHit = false;
		const fetchImpl = async (url) => {
			if (url.includes("/watch"))
				return {
					ok: true,
					text: async () =>
						watchHtml({
							...okPlayer,
							captions: {
								playerCaptionsTracklistRenderer: {
									captionTracks: [
										track({ baseUrl: "https://www.youtube.com/api/timedtext?v=ID&exp=xpe&lang=en" }),
									],
								},
							},
						}),
				};
			timedtextHit = true;
			// Same-origin logged-in cookies return the captions despite exp=xpe.
			return { ok: true, status: 200, text: async () => JSON.stringify(realJson3) };
		};
		const res = await fetchTranscript("ID", { fetchImpl });
		expect(timedtextHit).toBe(true);
		expect(res.ok).toBe(true);
		expect(res.text).toContain("We're no strangers");
	});

	it("falls back to a simplified timedtext URL when the pot-gated baseUrl returns empty", async () => {
		const fetchImpl = async (url) => {
			if (url.includes("/watch"))
				return {
					ok: true,
					text: async () =>
						watchHtml({
							...okPlayer,
							captions: {
								playerCaptionsTracklistRenderer: {
									captionTracks: [
										track({ baseUrl: "https://www.youtube.com/api/timedtext?v=ID&exp=xpe&lang=en" }),
									],
								},
							},
						}),
				};
			// The pot-gated (exp=xpe) baseUrl is rejected with an empty body; the
			// simplified URL (no server params, no exp flag) serves the captions.
			const body = url.includes("exp=xpe") ? "" : JSON.stringify(realJson3);
			return { ok: true, status: 200, text: async () => body };
		};
		const res = await fetchTranscript("ID", { fetchImpl });
		expect(res.ok).toBe(true);
		expect(res.text).toContain("We're no strangers");
	});

	it("recovers via the InnerTube web_creator player when timedtext is pot-blocked", async () => {
		// Watch page exposes an api key and a pot-gated (exp=xpe) WEB caption URL.
		const html = `<script>ytcfg.set({"INNERTUBE_API_KEY":"AIzaKEY","VISITOR_DATA":"VD"});</script>${watchHtml(
			{
				...okPlayer,
				captions: {
					playerCaptionsTracklistRenderer: {
						captionTracks: [track({ baseUrl: "https://www.youtube.com/api/timedtext?v=ID&exp=xpe&lang=en" })],
					},
				},
			},
		)}`;
		let sawAuth = false;
		const fetchImpl = async (url, opts) => {
			if (url.includes("/watch")) return { ok: true, status: 200, text: async () => html };
			// The pot-gated WEB timedtext (exp=xpe) and the simplified URL are empty.
			if (url.includes("timedtext") && !url.includes("signature"))
				return { ok: true, status: 200, text: async () => "" };
			if (url.includes("/youtubei/v1/player")) {
				// web_creator must be authenticated.
				if (opts?.headers?.Authorization?.startsWith("SAPISIDHASH ")) sawAuth = true;
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({
							playabilityStatus: { status: "OK" },
							captions: {
								playerCaptionsTracklistRenderer: {
									// Un-gated, server-signed caption URL (no exp=xpe).
									captionTracks: [
										track({ baseUrl: "https://www.youtube.com/api/timedtext?v=ID&lang=en&signature=SIG&key=yt8" }),
									],
								},
							},
						}),
				};
			}
			// The signed caption URL serves real json3.
			if (url.includes("timedtext") && url.includes("signature"))
				return { ok: true, status: 200, text: async () => JSON.stringify(realJson3) };
			throw new Error(`unexpected url ${url}`);
		};
		const res = await fetchTranscript("ID", { fetchImpl, cookieStr: "SAPISID=abc; __Secure-3PAPISID=def" });
		expect(sawAuth).toBe(true);
		expect(res.ok).toBe(true);
		expect(res.source).toBe("innertube");
		expect(res.text).toContain("We're no strangers");
	});

	it("skips the InnerTube player fallback when logged out (no SAPISID cookie)", async () => {
		const html = `<script>ytcfg.set({"INNERTUBE_API_KEY":"AIzaKEY"});</script>${watchHtml({
			...okPlayer,
			captions: {
				playerCaptionsTracklistRenderer: {
					captionTracks: [track({ baseUrl: "https://www.youtube.com/api/timedtext?v=ID&exp=xpe&lang=en" })],
				},
			},
		})}`;
		const fetchImpl = async (url) => {
			if (url.includes("/watch")) return { ok: true, status: 200, text: async () => html };
			if (url.includes("timedtext")) return { ok: true, status: 200, text: async () => "" };
			throw new Error(`unexpected url ${url}`); // player must NOT be called
		};
		const res = await fetchTranscript("ID", { fetchImpl, cookieStr: "" });
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("pot-blocked");
	});

	it("treats HTTP 200 + empty body as pot-blocked, not 'no captions'", async () => {
		const res = await fetchTranscript("ID", {
			fetchImpl: makeFetch({ html: watchHtml(okPlayer), timedtext: "" }),
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("pot-blocked");
	});

	it("reports no-captions when there are no tracks", async () => {
		const res = await fetchTranscript("ID", {
			fetchImpl: makeFetch({ html: watchHtml({ ...okPlayer, captions: null }), timedtext: "" }),
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("no-captions");
	});

	it("reports no-captions when the picked track has no baseUrl", async () => {
		const captions = {
			playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en" }] },
		};
		const res = await fetchTranscript("ID", {
			fetchImpl: makeFetch({ html: watchHtml({ ...okPlayer, captions }), timedtext: "" }),
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("no-captions");
	});

	it("reports not-playable for restricted videos", async () => {
		const res = await fetchTranscript("ID", {
			fetchImpl: makeFetch({
				html: watchHtml({ ...okPlayer, playabilityStatus: { status: "LOGIN_REQUIRED" } }),
				timedtext: "",
			}),
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("not-playable");
		expect(res.status).toBe("LOGIN_REQUIRED");
	});

	it("reports no-player-response for an interstitial page", async () => {
		const res = await fetchTranscript("ID", {
			fetchImpl: makeFetch({ html: "<html>consent</html>", timedtext: "" }),
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("no-player-response");
	});

	it("falls through to pot-blocked when the real fixture's caption fetches all return empty", async () => {
		// The real fixture's baseUrl is exp=xpe; with every timedtext attempt
		// (primary + simplified) returning empty, we end at pot-blocked — the
		// caller then escalates to the Gemini video fallback.
		const res = await fetchTranscript("ID", {
			fetchImpl: makeFetch({ html: realWatchHtml, timedtext: "" }),
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("pot-blocked");
	});

	it("reports fetch-failed when the initial watch fetch throws", async () => {
		const fetchImpl = async (url) => {
			if (url.includes("/watch")) throw new Error("network blip");
			return { ok: true, text: async () => "" };
		};
		const res = await fetchTranscript("ID", { fetchImpl });
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("fetch-failed");
		expect(res.detail).toContain("network blip");
	});

	it("reports timedtext-failed when the timedtext fetch throws", async () => {
		const fetchImpl = async (url) => {
			if (url.includes("/watch")) return { ok: true, text: async () => watchHtml(okPlayer) };
			throw new Error("timedtext network error");
		};
		const res = await fetchTranscript("ID", { fetchImpl });
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("timedtext-failed");
	});

	it("reports parse-failed for a non-JSON timedtext body", async () => {
		const res = await fetchTranscript("ID", {
			fetchImpl: makeFetch({ html: watchHtml(okPlayer), timedtext: "not json at all" }),
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("parse-failed");
	});

	it("reports empty-transcript when json3 has events but no text segments", async () => {
		const emptyJson3 = JSON.stringify({ events: [{ tStartMs: 0 }, { tStartMs: 100 }] });
		const res = await fetchTranscript("ID", {
			fetchImpl: makeFetch({ html: watchHtml(okPlayer), timedtext: emptyJson3 }),
		});
		expect(res.ok).toBe(false);
		expect(res.reason).toBe("empty-transcript");
	});
});
