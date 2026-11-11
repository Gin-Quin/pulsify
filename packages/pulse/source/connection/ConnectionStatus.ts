export type ConnectionStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "syncing"
	| "synced"
	/** The transport failed; waiting for the next attempt. */
	| "reconnecting"
	| "closing"
	| "closed"
	/** Stopped by an error that a retry cannot fix, until `connectPulse`. */
	| "error";
