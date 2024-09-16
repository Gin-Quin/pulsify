/**
 * A connector transmits updates to other services.
 */
export type Connector = {
	send(message: Uint8Array): void
}
