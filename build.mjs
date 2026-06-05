// Bundles src/ entry points into the extension root files that the manifest loads.
//
//   src/content.js     ->  content.js     (IIFE, injected into youtube.com)
//   src/background.js  ->  background.js  (service worker)
//   src/popup.js       ->  popup.js       (side panel settings UI)
//
// Shared, unit-tested logic lives in src/lib/*.js and is imported by the
// entries above. esbuild inlines it, so the browser never sees ES modules
// (content scripts can't be modules) while tests import the same source.

import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: {
		content: "src/content.js",
		background: "src/background.js",
		popup: "src/popup.js",
	},
	outdir: ".",
	bundle: true,
	format: "iife",
	target: ["chrome114"],
	platform: "browser",
	logLevel: "info",
	// Readable output: this ships to users' browsers and we want stack traces
	// that map to recognizable code during QA.
	minify: false,
	legalComments: "none",
};

if (watch) {
	const ctx = await context(options);
	await ctx.watch();
	console.log("[build] watching src/ for changes...");
} else {
	await build(options);
	console.log("[build] done");
}
