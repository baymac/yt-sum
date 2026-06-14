import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "jsdom",
		include: ["tests/unit/**/*.test.js"],
		globals: true,
		setupFiles: ["tests/setup.js"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.js"],
			// Entry files are thin wiring exercised by e2e; lib carries the logic.
			exclude: ["src/content.js", "src/background.js", "src/popup.js"],
			reporter: ["text", "html"],
		},
	},
});
