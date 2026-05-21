import type { ConnectionStatus } from "./ConnectionStatus";
import type { Connector } from "./Connector";

export type Connection = {
	connector: Connector;
	status: ConnectionStatus;
	close: () => unknown;
};
