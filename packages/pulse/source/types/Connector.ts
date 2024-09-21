/**
 * A connector transmits updates to other services.
 */
export type Connector = {
	send(message: Uint8Array): void;
};

/**
 * A list of default connectors.
 */
export const connectors = new Array<Connector>();

/**
 * Add connectors to the list of default connectors.
 */
export function useConnectors(values: Array<Connector>): void {
	for (const connector of values) {
		if (!connectors.includes(connector)) connectors.push(connector);
	}
}

/**
 * Remove connectors from the list of default connectors.
 */
export function removeConnectors(values: Array<Connector>): void {
	for (const connector of values) {
		const index = connectors.indexOf(connector);
		if (index !== -1) connectors.splice(index, 1);
	}
}
