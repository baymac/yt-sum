// Shared test setup: a minimal in-memory `chrome` mock reset before each test.
// Individual tests can reassign globalThis.chrome to exercise other behaviors.
import { beforeEach, vi } from "vitest";

export function makeChrome(initial = {}) {
	const sync = { ...initial };
	const session = {};
	return {
		storage: {
			sync: {
				get: vi.fn((keys, cb) => {
					const out = {};
					const arr = Array.isArray(keys)
						? keys
						: typeof keys === "string"
							? [keys]
							: Object.keys(keys || {});
					for (const k of arr) if (k in sync) out[k] = sync[k];
					if (cb) cb(out);
					return undefined;
				}),
				set: vi.fn((items, cb) => {
					Object.assign(sync, items);
					if (cb) cb();
					return undefined;
				}),
				_data: sync,
			},
			session: {
				get: vi.fn(async (keys) => {
					const out = {};
					const arr = Array.isArray(keys) ? keys : [keys];
					for (const k of arr) if (k in session) out[k] = session[k];
					return out;
				}),
				set: vi.fn(async (items) => {
					Object.assign(session, items);
				}),
				_data: session,
			},
		},
		runtime: {
			sendMessage: vi.fn(),
			onMessage: { addListener: vi.fn() },
			onInstalled: { addListener: vi.fn() },
			onStartup: { addListener: vi.fn() },
			lastError: undefined,
		},
		tabs: { query: vi.fn(), sendMessage: vi.fn() },
		sidePanel: { setOptions: vi.fn(), setPanelBehavior: vi.fn(), open: vi.fn() },
	};
}

beforeEach(() => {
	globalThis.chrome = makeChrome();
	// jsdom doesn't implement scrollTo; stub it so modal scroll-lock is testable.
	if (typeof window !== "undefined") window.scrollTo = () => {};
});
