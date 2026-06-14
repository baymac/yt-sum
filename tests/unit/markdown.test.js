import { describe, it, expect } from "vitest";
import { escapeHtml, escapeAttr, sanitizeUrl, formatSummary } from "../../src/lib/markdown.js";

describe("escapeHtml", () => {
	it("escapes angle brackets and ampersands", () => {
		expect(escapeHtml("<script>&\"'")).toBe("&lt;script&gt;&amp;\"'");
	});
	it("handles null/undefined safely", () => {
		expect(escapeHtml(null)).toBe("");
		expect(escapeHtml(undefined)).toBe("");
	});
});

describe("escapeAttr", () => {
	it("escapes quotes (which escapeHtml does not)", () => {
		expect(escapeAttr('a"b')).toBe("a&quot;b");
		expect(escapeAttr("a'b")).toBe("a&#39;b");
		expect(escapeAttr("<x>&")).toBe("&lt;x&gt;&amp;");
	});
});

describe("sanitizeUrl", () => {
	it("allows http and https", () => {
		expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
		expect(sanitizeUrl("http://example.com/x")).toBe("http://example.com/x");
	});
	it("blocks dangerous protocols", () => {
		expect(sanitizeUrl("javascript:alert(1)")).toBe("#");
		expect(sanitizeUrl("data:text/html,<script>")).toBe("#");
		expect(sanitizeUrl("vbscript:msgbox")).toBe("#");
		expect(sanitizeUrl("JAVASCRIPT:alert(1)")).toBe("#");
	});
	it("blocks relative and protocol-relative urls", () => {
		expect(sanitizeUrl("/foo")).toBe("#");
		expect(sanitizeUrl("//evil.com")).toBe("#");
	});
	it("rejects control-char smuggling", () => {
		expect(sanitizeUrl("java\tscript:alert(1)")).toBe("#");
	});
});

describe("formatSummary", () => {
	it("renders headings, paragraphs, and lists", () => {
		const html = formatSummary("# Title\n\nHello world\n\n- a\n- b");
		expect(html).toContain("<h1>Title</h1>");
		expect(html).toContain("<p>Hello world</p>");
		expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
	});
	it("renders ordered lists", () => {
		const html = formatSummary("1. one\n2. two");
		expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
	});
	it("renders bold, italic, and inline code", () => {
		const html = formatSummary("**bold** _italic_ `code`");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>italic</em>");
		expect(html).toContain("<code>code</code>");
	});
	it("handles multi-line fenced code blocks", () => {
		const html = formatSummary("```\nline1\nline2\n```");
		expect(html).toContain("<pre><code>line1\nline2</code></pre>");
	});
	it("escapes XSS in summary text", () => {
		const html = formatSummary("<img src=x onerror=alert(1)>");
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});
	it("sanitizes javascript: links to #", () => {
		const html = formatSummary("[click](javascript:alert(1))");
		expect(html).toContain('href="#"');
		expect(html).not.toContain("javascript:");
	});
	it("keeps safe links and adds noopener", () => {
		const html = formatSummary("[site](https://example.com)");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('rel="noopener noreferrer"');
	});
	it("preserves hyphens and balanced parens in URLs", () => {
		expect(formatSummary("[a](https://my-site.com/a-b)")).toContain('href="https://my-site.com/a-b"');
		expect(formatSummary("[w](https://en.wikipedia.org/wiki/Foo_(bar))")).toContain(
			'href="https://en.wikipedia.org/wiki/Foo_(bar)"',
		);
	});
	// Regression: a URL with a double-quote must not break out of the href
	// attribute and inject event handlers (the critical XSS the review caught).
	// The true property: after parsing, no element carries a live handler attr.
	const render = (md) => {
		const d = document.createElement("div");
		d.innerHTML = formatSummary(md);
		return d;
	};
	it("blocks attribute-injection via a quote in the link URL", () => {
		const d = render('[x](https://a"onmouseover="alert(1))');
		for (const el of d.querySelectorAll("*")) {
			expect(el.hasAttribute("onmouseover")).toBe(false);
		}
		const a = d.querySelector("a");
		if (a) expect(a.getAttribute("href")).toBe("#");
	});
	it("blocks zero-interaction autofocus/onfocus injection", () => {
		const d = render('[a](https://x"autofocus onfocus="alert(1)tabindex="0)');
		for (const el of d.querySelectorAll("*")) {
			expect(el.hasAttribute("onfocus")).toBe(false);
			expect(el.hasAttribute("autofocus")).toBe(false);
		}
	});
	it("does not let emphasis bleed into an emitted href", () => {
		const html = formatSummary("[a](https://x.com/__a__)");
		expect(html).toContain('href="https://x.com/__a__"');
		expect(html).not.toContain("<strong>");
	});
	it("returns empty string for empty input", () => {
		expect(formatSummary("")).toBe("");
		expect(formatSummary(null)).toBe("");
	});
	it("closes an unterminated list at EOF", () => {
		const html = formatSummary("- only item");
		expect(html).toContain("<ul><li>only item</li></ul>");
	});
});
