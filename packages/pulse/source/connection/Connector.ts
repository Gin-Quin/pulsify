/** A transport carries complete binary frames and owns no CRDT classes. */
export type ConnectorSession = {
	/** Set only after the endpoint has explicitly advertised/negotiated support. */
	protocolVersion?: 1 | 2 | 3;
	/**
	 * The endpoint relays presence frames (kind 7). Set only for an endpoint
	 * known to understand them: an older relay rejects the frames.
	 */
	presence?: boolean;
	send(bytes: Uint8Array): Promise<void>;
	close(): void;
};
export type Connector = {
	kind: "remote" | "local";
	/**
	 * Local connectors: a name for the store behind this connector. Pulses reuse
	 * actor IDs among the pages that share the store. A local connector without
	 * it gives its pulses a random actor.
	 */
	actorPool?: string;
	open(input: {
		docId: string;
		signal: AbortSignal;
		onMessage(bytes: Uint8Array): void;
		onClose(error?: Error): void;
	}): Promise<ConnectorSession>;
};
export type ConnectorKind = Connector["kind"];
