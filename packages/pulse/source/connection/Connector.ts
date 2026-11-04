/** A transport carries complete binary frames and owns no CRDT classes. */
export type ConnectorSession = {
	send(bytes: Uint8Array): Promise<void>;
	close(): void;
};
export type Connector = {
	kind: "remote" | "local";
	open(input: {
		docId: string;
		signal: AbortSignal;
		onMessage(bytes: Uint8Array): void;
		onClose(error?: Error): void;
	}): Promise<ConnectorSession>;
};
export type ConnectorKind = Connector["kind"];
