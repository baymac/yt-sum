// Web-page (article / blog post) summarization. Mirrors the YouTube transcript
// path: an instruction template, prompt builders, and a self-contained text
// extractor that the background injects into the page via
// chrome.scripting.executeScript. Non-YouTube pages have no content script, so
// the extractor below is the only code that ever runs in their context.

// Keep long pages under the free-tier TPM ceiling (same budget as transcripts).
export const MAX_PAGE_CHARS = 200000;

// Reworded from the YouTube SUMMARY_INSTRUCTION so the wording stays familiar:
// "video → article", "watch → read".
export const PAGE_SUMMARY_INSTRUCTION = `You are summarizing an article so the reader does NOT have to read it. Produce a clear, well-structured Markdown summary with these sections:

## TL;DR
2-3 sentences capturing the core message.

## Key Points
A bulleted list of the main points, arguments, or steps in the order they appear. Be specific — include the concrete facts, numbers, names, and conclusions, not vague descriptions.

## Details
A few short paragraphs walking through the substance so the reader gets everything important without reading.

## Takeaways
The most useful insights or action items.

Write in plain, direct language. Do not invent content that isn't supported by the source.`;

/** Clamp page text and note if it was truncated. */
export function clampPageText(text, max = MAX_PAGE_CHARS) {
	if (!text) return "";
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[content truncated for length]`;
}

/** Build the one-shot "summarize this page" prompt. */
export function buildPagePrompt({ title, url, pageText }) {
	const head = title ? `Article title: ${title}\n` : "";
	const link = url ? `URL: ${url}\n` : "";
	return `${PAGE_SUMMARY_INSTRUCTION}\n\n${head}${link}\nARTICLE:\n${clampPageText(pageText)}`;
}

/**
 * Seed context so the chat can answer questions about the page even before the
 * user clicks Summarize. Kept as a hidden turn (see popup.js).
 */
export function buildPageContext({ title, url, pageText }) {
	const head = title ? `Article title: ${title}\n` : "";
	const link = url ? `URL: ${url}\n` : "";
	return `You are answering questions about a web article using its text as the source. If the text doesn't cover something, say so.\n\n${head}${link}\nARTICLE:\n${clampPageText(pageText)}`;
}

/**
 * Runs INSIDE the target page (serialized by chrome.scripting.executeScript via
 * Function.prototype.toString), so it must be fully self-contained: reference
 * only page globals (document/location), never module scope.
 *
 * @returns {{title:string, text:string, url:string}}
 */
export function extractPageContent() {
	const STRIP =
		'script,style,noscript,template,nav,header,footer,aside,form,iframe,svg,button,select,[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"]';
	const root =
		document.querySelector("article") ||
		document.querySelector("main") ||
		document.querySelector('[role="main"]') ||
		document.body;

	let text = "";
	if (root) {
		const clone = root.cloneNode(true);
		clone.querySelectorAll(STRIP).forEach((el) => el.remove());
		text = (clone.innerText || clone.textContent || "")
			.replace(/[ \t ]+/g, " ")
			.replace(/\n[ \t]+/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	const h1 = document.querySelector("h1");
	const title =
		((h1 && (h1.innerText || h1.textContent)) || "").replace(/\s+/g, " ").trim() ||
		(document.title || "").replace(/\s+/g, " ").trim() ||
		location.href;

	return { title, text, url: location.href };
}
