// Playwright fixture: launch a persistent Chromium with the unpacked extension
// loaded (new headless mode supports extensions), expose the extension id, and
// optionally seed cookies exported from the user's real browser.
import { test as base, chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = resolve(__dirname, "../../");
const COOKIES_PATH = resolve(__dirname, "../../.context/youtube-cookies.json");

export const test = base.extend({
	context: async ({}, use) => {
		const context = await chromium.launchPersistentContext("", {
			headless: false,
			args: [
				"--headless=new",
				`--disable-extensions-except=${EXTENSION_PATH}`,
				`--load-extension=${EXTENSION_PATH}`,
				"--no-first-run",
				"--no-default-browser-check",
			],
		});

		// Bypass the EU consent interstitial for logged-out browsing.
		await context.addCookies([
			{ name: "SOCS", value: "CAISEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg", domain: ".youtube.com", path: "/" },
			{ name: "CONSENT", value: "YES+cb", domain: ".youtube.com", path: "/" },
		]);

		// If the user exported real YouTube cookies (see import-brave-cookies.mjs),
		// seed them so the run is logged in and transcript fetch uses a real session.
		if (existsSync(COOKIES_PATH)) {
			try {
				const cookies = JSON.parse(readFileSync(COOKIES_PATH, "utf8"));
				await context.addCookies(cookies);
				console.log(`[e2e] seeded ${cookies.length} cookies from Brave export`);
			} catch (e) {
				console.warn("[e2e] could not seed cookies:", e.message);
			}
		}

		await use(context);
		await context.close();
	},

	extensionId: async ({ context }, use) => {
		let [sw] = context.serviceWorkers();
		if (!sw) sw = await context.waitForEvent("serviceworker");
		await use(new URL(sw.url()).host);
	},
});

export const expect = test.expect;

// A canned Gemini response so the full pipeline renders without a real key.
export const MOCK_SUMMARY = "## TL;DR\nThis is a mocked Gemini summary used for E2E.\n\n## Key Points\n- First point\n- Second point";

export async function mockGemini(context, text = MOCK_SUMMARY) {
	await context.route("https://generativelanguage.googleapis.com/**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
		}),
	);
}

export async function setApiKey(context, extensionId, key = "E2E_TEST_KEY") {
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/popup.html`);
	await page.evaluate(
		(k) => new Promise((r) => chrome.storage.sync.set({ geminiApiKey: k }, r)),
		key,
	);
	await page.close();
}
