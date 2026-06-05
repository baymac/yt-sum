import { describe, it, expect, vi } from "vitest";
import { storageGet, storageSet } from "../../src/lib/storage.js";
import { makeChrome } from "../setup.js";

describe("storageGet / storageSet (callback style)", () => {
	it("round-trips values", async () => {
		globalThis.chrome = makeChrome({ geminiApiKey: "abc" });
		expect(await storageGet(["geminiApiKey"])).toEqual({ geminiApiKey: "abc" });
		await storageSet({ darkMode: true });
		expect(await storageGet(["darkMode"])).toEqual({ darkMode: true });
	});

	it("resolves to {} when storage throws", async () => {
		globalThis.chrome = {
			storage: {
				sync: {
					get: () => {
						throw new Error("boom");
					},
				},
			},
		};
		expect(await storageGet(["x"])).toEqual({});
	});
});

describe("storageGet / storageSet (promise style)", () => {
	it("supports promise-returning implementations", async () => {
		const data = { foo: "bar" };
		globalThis.chrome = {
			storage: {
				sync: {
					get: vi.fn(() => Promise.resolve(data)),
					set: vi.fn(() => Promise.resolve()),
				},
			},
		};
		expect(await storageGet(["foo"])).toEqual(data);
		await expect(storageSet({ a: 1 })).resolves.toBeUndefined();
	});
});

describe("storageSet lastError rejection", () => {
	it("rejects when chrome.runtime.lastError is set during the callback", async () => {
		const chrome = makeChrome();
		chrome.storage.sync.set = vi.fn((items, cb) => {
			chrome.runtime.lastError = { message: "quota exceeded" };
			cb?.();
			return undefined;
		});
		globalThis.chrome = chrome;
		await expect(storageSet({ x: 1 })).rejects.toThrow("quota exceeded");
	});
});
