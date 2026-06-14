// Promise wrappers over chrome.storage.sync that tolerate both callback-style
// and promise-style implementations across Chrome versions and test mocks.

export function storageGet(keys) {
	return new Promise((resolve) => {
		try {
			const maybePromise = chrome.storage.sync.get(keys, (result) => {
				resolve(result || {});
			});
			// Some environments return a promise AND ignore the callback.
			if (maybePromise && typeof maybePromise.then === "function") {
				maybePromise.then((r) => resolve(r || {})).catch(() => resolve({}));
			}
		} catch (_) {
			resolve({});
		}
	});
}

export function storageSet(items) {
	return new Promise((resolve, reject) => {
		try {
			const maybePromise = chrome.storage.sync.set(items, () => {
				const err = chrome.runtime?.lastError;
				if (err) reject(new Error(err.message));
				else resolve();
			});
			if (maybePromise && typeof maybePromise.then === "function") {
				maybePromise.then(resolve).catch(reject);
			}
		} catch (e) {
			reject(e);
		}
	});
}
