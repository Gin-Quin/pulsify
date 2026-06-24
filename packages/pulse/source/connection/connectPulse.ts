import type { Pulse } from "pulse/pulses/Pulse";
import { getPulseMeta } from "pulse/pulses/PulseMeta";
import { hasPulseLatestVersion } from "pulse/utilities/hasPulseLatestVersion";
import { isOnline } from "pulse/utilities/isOnline";
import { isPulseLoaded } from "pulse/utilities/isPulseLoaded";

export type ConnectPulseResolvers<P extends Pulse> = {
	/**
	 * A pulse is "ready" when either:
	 * - data has been loaded from all local connectors and either:
	 *   - pulse has latest version
	 *   - or no internet connection
	 * - or data has been loaded from at least one remote connector
	 */
	ready: Promise<P>;

	/**
	 * A pulse is "connected" when data has been received
	 * from all connectors.
	 */
	connected: Promise<P>;

	/**
	 * A pulse is "connected" when data has been received
	 * from all connectors and all connectors have received
	 * the latest version of the pulse.
	 */
	synced: Promise<P>;
};

/**
 * Connect an idle pulse
 */
export function connectPulse<P extends Pulse>(
	pulse: P,
): ConnectPulseResolvers<P> {
	const meta = getPulseMeta(pulse);
	const connections = meta.connections;

	const ready = Promise.withResolvers<P>();
	const connected = Promise.withResolvers<P>();
	const synced = Promise.withResolvers<P>();

	const localConnections = connections.filter(
		(connection) => connection.connector.kind === "local",
	);
	const remoteConnections = connections.filter(
		(connection) => connection.connector.kind === "remote",
	);

	// first, connect with all local connectors
	const localConnectionPromises = localConnections.map((connection) =>
		connection.connect(),
	);

	// when all local connectors have connected, indicate the pulse is ready
	// if the pulse has the latest version, or if we're offline
	Promise.allSettled(localConnectionPromises).then(async () => {
		if (isPulseLoaded(pulse) && (hasPulseLatestVersion(pulse) || !isOnline())) {
			ready.resolve();
		}

		// then, connect with all remote connectors
		// the currently loaded data will be used as clock vector
		// to prevent remote database to load "all" the pulse history
		remoteConnections.map((connection) =>
			connection.connect().then(() => {
				if (isPulseLoaded(pulse)) {
					ready.resolve();
				}
			}),
		);

		await Promise.allSettled(remoteConnections);

		if (isPulseLoaded(pulse)) {
			connected.resolve();

			// finally, sync back data if necessary
			await Promise.allSettled(
				connections.map((connection) => connection.sync()),
			);
		} else {
			// throw? This means the document couldn't connect to any remote connector
		}
	});

	return {
		ready: ready.promise,
		connected: connected.promise,
		synced: synced.promise,
	};
}
