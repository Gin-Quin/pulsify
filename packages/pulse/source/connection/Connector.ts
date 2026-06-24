import type { ClockVector } from "json-joy";
import type { Delta } from "json-joy/lib/json-crdt/delta/Delta";

export type ConnectorKind = "remote" | "local";

export type Connector = {
	/**
	 * Indicates if the connector is local (very fast access, not needing
	 * internet) or remote (higher latency, relying on an external database).
	 */
	kind: ConnectorKind;

	/**
	 * @param clockVector If the document is already loaded (for example,
	 * from local connector), thenwe can pass the version vector to prevent
	 * loading the full document from the subsequent connectors.
	 */
	connect: (input: { clockVector: ClockVector | null }) => {
		close: () => unknown;
		done: Promise<null | {
			delta: Delta;
			clockVector: ClockVector;
		}>;
	};

	/**
	 * Sends data back to the connector to make sure it has the latest version.
	 */
	sync: (input: { delta: Delta }) => Promise<void>;
};
