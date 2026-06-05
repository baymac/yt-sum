import { describe, it, expect } from "vitest";
import {
	extractVideoId,
	isWatchUrl,
	getWatchVideoId,
	getVideoTitle,
	findInsertionPoint,
	insertButton,
} from "../../src/lib/youtube-dom.js";

describe("extractVideoId", () => {
	it.each([
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["/watch?v=dQw4w9WgXcQ&t=10s", "dQw4w9WgXcQ"],
		["https://www.youtube.com/watch?list=PLx&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
		["https://www.youtube.com/shorts/abcdefghijk", "abcdefghijk"],
		["https://www.youtube.com/embed/abcdefghijk", "abcdefghijk"],
	])("extracts id from %s", (url, expected) => {
		expect(extractVideoId(url)).toBe(expected);
	});
	it("returns null for non-video urls", () => {
		expect(extractVideoId("https://www.youtube.com/")).toBeNull();
		expect(extractVideoId("")).toBeNull();
		expect(extractVideoId(null)).toBeNull();
	});
});

describe("isWatchUrl / getWatchVideoId", () => {
	it("detects watch pages", () => {
		expect(isWatchUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
		expect(isWatchUrl("/watch?v=dQw4w9WgXcQ")).toBe(true);
		expect(isWatchUrl("https://www.youtube.com/")).toBe(false);
		expect(isWatchUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(false);
	});
	it("returns the current watch id, or null", () => {
		expect(getWatchVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
		expect(getWatchVideoId("https://www.youtube.com/")).toBeNull();
		expect(getWatchVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
	});
});

describe("getVideoTitle", () => {
	function container(html) {
		const div = document.createElement("div");
		div.innerHTML = html;
		return div;
	}

	it("reads a clean title element", () => {
		const c = container('<a id="video-title" href="/watch?v=dQw4w9WgXcQ">Cool Video</a>');
		expect(getVideoTitle(c, c.querySelector("a"))).toBe("Cool Video");
	});
	it("skips a duration-only title and falls back to aria-label", () => {
		const c = container(
			'<span id="video-title">9:06</span><a href="/watch?v=dQw4w9WgXcQ" aria-label="Real Title by Channel 9:06"></a>',
		);
		expect(getVideoTitle(c, c.querySelector("a"))).toBe("Real Title");
	});
	it("strips a trailing duration from a title", () => {
		const c = container('<a id="video-title" href="/watch?v=x">My Talk 12:34</a>');
		expect(getVideoTitle(c, c.querySelector("a"))).toBe("My Talk");
	});
	it("returns empty string when nothing usable", () => {
		const c = container('<a href="/watch?v=x"></a>');
		expect(getVideoTitle(c, c.querySelector("a"))).toBe("");
	});
	it("falls back to h3 > a text when no #video-title element exists", () => {
		const c = container('<h3><a href="/watch?v=dQw4w9WgXcQ">H3 Video Title</a></h3>');
		expect(getVideoTitle(c, c.querySelector("a"))).toBe("H3 Video Title");
	});
	it("falls back to videoLink.title attribute as a last resort", () => {
		const c = container('<a href="/watch?v=dQw4w9WgXcQ" title="Title From Attr"></a>');
		expect(getVideoTitle(c, c.querySelector("a"))).toBe("Title From Attr");
	});
});

describe("findInsertionPoint / insertButton", () => {
	function container(html) {
		const div = document.createElement("div");
		div.innerHTML = html;
		return div;
	}

	it("inserts after the metadata line when present", () => {
		const c = container('<div id="meta"></div><div id="metadata-line"></div>');
		const btn = document.createElement("button");
		expect(insertButton(c, btn)).toBe(true);
		const meta = c.querySelector("#metadata-line");
		expect(meta.nextSibling).toBe(btn);
	});
	it("falls back to appending to the container", () => {
		const c = container("<span>nothing useful</span>");
		const spot = findInsertionPoint(c);
		expect(spot.parent).toBe(c);
		const btn = document.createElement("button");
		expect(insertButton(c, btn)).toBe(true);
		expect(c.contains(btn)).toBe(true);
	});
	it("inserts before the first child of #details when no metadata line exists", () => {
		const c = container('<div id="details"><span id="first-child"></span></div>');
		const btn = document.createElement("button");
		expect(insertButton(c, btn)).toBe(true);
		const details = c.querySelector("#details");
		expect(details.firstElementChild).toBe(btn);
	});
});
