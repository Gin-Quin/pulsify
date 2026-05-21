/**
 * Represents the connection status of a pulse.
 * - `idle`: No connection established yet.
 * - `connecting`: Connecting to the connector, no data yet.
 * - `synced`: Synced with the connector.
 */
export type ConnectionStatus = "idle" | "connecting" | "connected";
