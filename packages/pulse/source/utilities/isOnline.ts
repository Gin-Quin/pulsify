let onlineMode = true;

export function setOnlineMode(online: boolean): void {
	onlineMode = online;
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
