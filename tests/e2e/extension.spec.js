// End-to-end: load the real extension into Chromium and drive real youtube.com.
// Gemini is mocked (no key in CI); everything up to the Gemini call — content
// script injection against real YouTube markup, the message pipeline, and the
// modal render — is exercised for real.
//
// Core tests use the search-results page because it renders video containers
// (ytd-video-renderer) even when logged out, so they're deterministic. The
// home-feed test additionally proves the logged-in feed when a Brave session is
// present (see import-brave-cookies.mjs), and skips if the session has expired.
import { test, expect, mockGemini, setApiKey } from "./fixtures.js";

const SHOTS = "tests/e2e/screenshots";
const SEARCH = "https://www.youtube.com/results?search_query=lofi+hip+hop";

test("extension loads with a service worker", async ({ extensionId }) => {
	expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test("injects Summarize buttons on a real video list", async ({ context, extensionId }) => {
	await mockGemini(context);
	await setApiKey(context, extensionId);

	const page = await context.newPage();
	await page.goto(SEARCH, { waitUntil: "domcontentloaded" });

	await expect(page.locator(".yt-sum-summarize-btn").first()).toBeVisible({ timeout: 45_000 });
	expect(await page.locator(".yt-sum-summarize-btn").count()).toBeGreaterThan(0);
	await page.screenshot({ path: `${SHOTS}/list-buttons.png` });
});

test("clicking a button opens the modal and renders a summary", async ({ context, extensionId }) => {
	await mockGemini(context);
	await setApiKey(context, extensionId);

	const page = await context.newPage();
	await page.goto(SEARCH, { waitUntil: "domcontentloaded" });
	await page.locator(".yt-sum-summarize-btn").first().waitFor({ timeout: 45_000 });
	await page.locator(".yt-sum-summarize-btn").first().click();

	const modal = page.locator("#yt-sum-summary-modal");
	await expect(modal).toBeVisible();
	// Whether the transcript path or the video-fallback path was taken, both
	// reach the mocked Gemini response.
	await expect(modal.locator(".yt-sum-modal-body")).toContainText("mocked Gemini summary", {
		timeout: 30_000,
	});
	await page.screenshot({ path: `${SHOTS}/modal-summary.png` });
});

test("injects buttons on the logged-in home feed (when a Brave session is present)", async ({ context, extensionId }) => {
	await mockGemini(context);
	await setApiKey(context, extensionId);

	const page = await context.newPage();
	await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(6000);

	const signedIn = await page.evaluate(
		() => !!document.querySelector("#avatar-btn, ytd-topbar-menu-button-renderer img"),
	);
	test.skip(!signedIn, "No logged-in YouTube session (run import-brave-cookies.mjs to enable).");

	await expect(page.locator(".yt-sum-summarize-btn").first()).toBeVisible({ timeout: 30_000 });
	await page.screenshot({ path: `${SHOTS}/home-buttons.png` });
});

test("injects a Summarize button on a watch page", async ({ context, extensionId }) => {
	await mockGemini(context);
	await setApiKey(context, extensionId);

	const page = await context.newPage();
	// "Me at the zoo" — short, stable, public.
	await page.goto("https://www.youtube.com/watch?v=jNQXAC9IVRw", { waitUntil: "domcontentloaded" });

	const watchBtn = page.locator("#yt-sum-watch-btn");
	await expect(watchBtn).toBeVisible({ timeout: 45_000 });
	await expect(watchBtn).toContainText("Summarize");
	await page.screenshot({ path: `${SHOTS}/watch-button.png` });
});
