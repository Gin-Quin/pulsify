/**
 * Synchronization status of a pulse with its connectors:
 * - `idle`: No connection established yet.
 * - `syncing`: Syncing to the connectors, no data yet.
 * - `ready`: Data has been loaded from one of the connectors and has the last version.
 * - `synced`: Synced with all local connectors and at least one remote connector.
 * Most of the time, you want to wait either for "ready" if you're eager to display
 * the data, or "synced" if you want to make sure the data has been synced with all
 * connectors.
 */
export type SynchronizationStatus = "idle" | "syncing" | "ready" | "synced";
