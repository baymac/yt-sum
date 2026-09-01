import { describe, it, expect } from "vitest";
import {
	PAGE_SUMMARY_INSTRUCTION,
	buildPagePrompt,
	buildPageContext,
	clampPageText,
	extractPageContent,
	MAX_PAGE_CHARS,
} from "../../src/lib/page.js";

describe("page summary prompts", () => {
	it("instruction is article-oriented (read, not watch)", () => {
		expect(PAGE_SUMMARY_INSTRUCTION).toContain("summarizing an article");
		expect(PAGE_SUMMARY_INSTRUCTION).toContain("does NOT have to read it");
		// Same section skeleton as the YouTube prompt.
		for (const s of ["## TL;DR", "## Key Points", "## Details", "## Takeaways"]) {
			expect(PAGE_SUMMARY_INSTRUCTION).toContain(s);
		}
	});

	it("buildPagePrompt embeds title, url, and the article body under ARTICLE:", () => {
		const p = buildPagePrompt({ title: "My Post", url: "https://ex.com/p", pageText: "hello world" });
		expect(p).toContain("Article title: My Post");
		expect(p).toContain("URL: https://ex.com/p");
		expect(p).toContain("\nARTICLE:\nhello world");
		expect(p.startsWith(PAGE_SUMMARY_INSTRUCTION)).toBe(true);
	});

	it("buildPageContext frames a grounded Q&A seed", () => {
		const c = buildPageContext({ title: "T", url: "u", pageText: "body" });
		expect(c).toContain("answering questions about a web article");
		expect(c).toContain("\nARTICLE:\nbody");
	});

	it("clampPageText truncates overlong text and notes it", () => {
		const long = "x".repeat(MAX_PAGE_CHARS + 500);
		const out = clampPageText(long);
		expect(out.length).toBeLessThan(long.length);
		expect(out).toContain("[content truncated for length]");
		expect(clampPageText("short")).toBe("short");
		expect(clampPageText("")).toBe("");
	});
});

describe("extractPageContent (runs in-page)", () => {
	it("prefers <article>, strips chrome, and reads a title", () => {
		document.body.innerHTML = `
			<nav>menu junk</nav>
			<article>
				<h1>The Headline</h1>
				<p>First paragraph.</p>
				<script>var junk = 1;</script>
				<p>Second paragraph.</p>
			</article>
			<footer>footer junk</footer>`;
		const r = extractPageContent();
		expect(r.title).toBe("The Headline");
		expect(r.text).toContain("First paragraph.");
		expect(r.text).toContain("Second paragraph.");
		expect(r.text).not.toContain("menu junk");
		expect(r.text).not.toContain("footer junk");
		expect(r.text).not.toContain("var junk");
	});
});
