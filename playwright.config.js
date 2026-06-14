import { defineConfig } from "@playwright/test";

// E2E loads the unpacked extension into Chromium and drives real youtube.com.
// One worker: a persistent context with an extension can't be parallelized.
export default defineConfig({
	testDir: "tests/e2e",
	timeout: 90_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
});
