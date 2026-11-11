let onlineMode = true;
const onlineListeners = new Set<() => void>();
let watchingBrowser = false;

/** `false` pauses reconnection attempts; `true` resumes them immediately. */
export function setOnlineMode(online: boolean): void {
	onlineMode = online;
	if (online) notifyOnline();
}

export function isOnlineMode(): boolean {
	return onlineMode;
}

/**
 * In a browser, check if internet is connected.
 * On other environments, return true.
 */
export function isOnline(): boolean {
	if (!onlineMode) return false;
	// In browser environment, use navigator.onLine
	if (typeof navigator !== "undefined" && "onLine" in navigator) {
		return navigator.onLine ?? true;
	}
	// In non-browser environments (Bun, Node), assume always online
	return true;
}

/** Called when the network may be back: the browser's `online` event or `setOnlineMode(true)`. */
export function onOnline(listener: () => void): () => void {
	if (!watchingBrowser && typeof globalThis.addEventListener === "function") {
		watchingBrowser = true;
		globalThis.addEventListener("online", notifyOnline);
	}
	onlineListeners.add(listener);
	return () => onlineListeners.delete(listener);
}

function notifyOnline(): void {
	if (!isOnline()) return;
	for (const listener of [...onlineListeners]) listener();
}
