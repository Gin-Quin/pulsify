/**
 * Synchronization status of a pulse with its connectors:
 * - `idle`: No connection established yet.
 * - `connecting`: Connecting to the connectors, no data yet.
 * - `local`: Synced with all local connectors.
 * - `synced`: Synced with all local and remote connectors.
 */
export type SynchronizationStatus = "idle" | "syncing" | "local" | "synced";
