/** `offline`: a connector is unreachable and being retried; local edits continue. */
export type SynchronizationStatus =
	"idle" | "syncing" | "ready" | "synced" | "offline" | "error";
