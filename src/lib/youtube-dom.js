// Pure-ish DOM helpers for reading YouTube's markup and placing buttons.
// Kept free of side effects beyond the DOM node passed in, so jsdom can test
// them against real container HTML.

export const VIDEO_CONTAINER_SELECTORS = [
	"ytd-rich-item-renderer",
	"ytd-video-renderer",
	"ytd-grid-video-renderer",
	"ytd-compact-video-renderer",
	"ytd-playlist-video-renderer",
	"ytd-rich-grid-media",
];

const DURATION_RE = /^\d+:\d+(?::\d+)?$/;

/**
 * Extract a video id from any YouTube URL, absolute or relative. Handles
 * /watch?v=, &v= within a playlist URL, youtu.be/, /shorts/, and /embed/.
 * Feed thumbnails often use relative hrefs (`/watch?v=...`), so this must not
 * depend on the youtube.com host being present.
 */
export function extractVideoId(url) {
	if (!url) return null;
	const path = url.match(/(?:youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/);
	if (path) return path[1];
	const query = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
	return query ? query[1] : null;
}

/** True if the URL is a YouTube watch page. */
export function isWatchUrl(url) {
	if (!url) return false;
	try {
		const u = new URL(url, "https://www.youtube.com");
		return u.pathname === "/watch" && u.searchParams.has("v");
	} catch (_) {
		return /\/watch\?(?:.*&)?v=/.test(url);
	}
}

/** Video id of the current watch page (or null). */
export function getWatchVideoId(url) {
	try {
		const u = new URL(url, "https://www.youtube.com");
		if (u.pathname !== "/watch") return null;
		const v = u.searchParams.get("v");
		return v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
	} catch (_) {
		return null;
	}
}

const looksLikeTitle = (s) => !!s && !DURATION_RE.test(s.trim());

/**
 * Best-effort video title from a feed container. Tries the dedicated title
 * elements, then aria-labels, stripping a trailing "... 9:06" duration and a
 * "Title by Channel" suffix.
 */
export function getVideoTitle(container, videoLink) {
	const clean = (s) => (s || "").replace(/\s+\d+:\d+(?::\d+)?\s*$/, "").trim();

	const titleEl = container?.querySelector?.(
		"#video-title, a#video-title-link, #video-title-link",
	);
	if (titleEl) {
		const t =
			titleEl.textContent?.trim() ||
			titleEl.getAttribute?.("aria-label") ||
			titleEl.getAttribute?.("title");
		if (looksLikeTitle(t)) return clean(t);
	}

	const h3 = container?.querySelector?.('h3 a[href*="/watch?v="]');
	if (h3) {
		const t = h3.textContent?.trim() || h3.getAttribute?.("aria-label");
		if (looksLikeTitle(t)) return clean(t);
	}

	const aria = videoLink?.getAttribute?.("aria-label");
	if (looksLikeTitle(aria)) {
		const byMatch = aria.match(/^(.+?)\s+by\s+/);
		return clean(byMatch ? byMatch[1] : aria);
	}

	const titleAttr = videoLink?.title || videoLink?.getAttribute?.("title");
	if (looksLikeTitle(titleAttr)) return clean(titleAttr);

	return "";
}

/**
 * Find the element after which a Summarize button should be inserted. Returns
 * {parent, before} or null. Tries metadata line, details, thumbnail, title.
 */
export function findInsertionPoint(container) {
	// Ordered priority — a combined comma selector would return DOM order, but
	// we specifically prefer the metadata line (sits right under the title).
	const meta =
		container.querySelector("#metadata-line") ||
		container.querySelector("#meta") ||
		container.querySelector("ytd-video-meta-block");
	if (meta?.parentNode) return { parent: meta.parentNode, before: meta.nextSibling };

	const details = container.querySelector("#details, #dismissible");
	if (details?.firstElementChild)
		return { parent: details, before: details.firstElementChild };

	const thumb = container.querySelector("ytd-thumbnail, #thumbnail, a#thumbnail");
	if (thumb?.parentNode) return { parent: thumb.parentNode, before: thumb.nextSibling };

	const title = container.querySelector("#video-title, #video-title-link, h3");
	if (title?.parentNode) return { parent: title.parentNode, before: title.nextSibling };

	return { parent: container, before: null };
}

/** Insert `button` into `container` at the best spot. Returns true on success. */
export function insertButton(container, button) {
	try {
		const spot = findInsertionPoint(container);
		if (!spot) return false;
		spot.parent.insertBefore(button, spot.before);
		return true;
	} catch (_) {
		return false;
	}
}
