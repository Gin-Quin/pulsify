import type { PulseMeta } from "../pulses/PulseMeta.js";
import { vectorCovers } from "./PulseVersionVector.js";

/** Derive a connected pulse's status from its connections. */
export function refreshPulseStatus(meta: PulseMeta): void {
	if (!meta.connecting) return;
	const { connections } = meta;
	if (connections.some((connection) => connection.status === "error"))
		meta.status = "error";
	else if (
		meta.loaded &&
		connections.every(
			(connection) =>
				connection.status === "synced" &&
				vectorCovers(connection.clockVector, meta.log.vector),
		)
	)
		meta.status = "synced";
	else if (
		connections.some((connection) => connection.status === "reconnecting")
	)
		meta.status = "offline";
	else meta.status = meta.loaded ? "ready" : "syncing";
}
