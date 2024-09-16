import { type Connector } from "../types/Connector"

export const connectors = new Array<Connector>()

export function useConnectors(values: Array<Connector>): void {
	for (const connector of values) {
		if (!connectors.includes(connector)) connectors.push(connector)
	}
}

export function removeConnectors(values: Array<Connector>): void {
	for (const connector of values) {
		const index = connectors.indexOf(connector)
		if (index !== -1) connectors.splice(index, 1)
	}
}
