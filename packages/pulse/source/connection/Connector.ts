export type ConnectorKind = "remote" | "local";

export type Connector = {
	kind: ConnectorKind;
	connect: () => { close: () => unknown; done: Promise<unknown> };
};
