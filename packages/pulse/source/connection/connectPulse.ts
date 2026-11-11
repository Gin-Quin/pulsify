import type { Pulse } from "../pulses/Pulse.js";
import { getPulseMeta } from "../pulses/PulseMeta.js";
import { PulseError } from "../protocol/errors.js";
import { deferred } from "../utilities/deferred.js";
import type { Connection } from "./Connection.js";
import { vectorCovers } from "./PulseVersionVector.js";
import { refreshPulseStatus } from "./refreshPulseStatus.js";

export type ConnectPulseOptions = { signal?: AbortSignal; timeoutMs?: number };
export type ConnectPulseResolvers<P extends Pulse<any>> = {
	ready: Promise<P>;
	connected: Promise<P>;
	synced: Promise<P>;
};

const tasks = new WeakMap<object, { settled: boolean; succeeded: boolean }>();
const established = (connection: Connection) =>
	connection.status === "connected" ||
	connection.status === "syncing" ||
	connection.status === "synced";

/**
 * Keep the pulse synchronized with all its connectors, local and remote,
 * until `disconnectPulse` or `destroyPulse`. Failing connectors are retried
 * with backoff and resynchronized from scratch when they come back.
 *
 * The promises describe the current synchronization: `ready` when data is
 * usable, `connected` when every connector has downloaded, `synced` when every
 * connector acknowledged the local history. They reject on `timeoutMs` (the
 * connectors keep retrying), on a non-retryable error, on abort or disconnect.
 * Calling again after a settled attempt retries failing connectors now.
 */
export function connectPulse<P extends Pulse<any>>(
	pulse: P,
	options: ConnectPulseOptions = {},
): ConnectPulseResolvers<P> {
	const meta = getPulseMeta(pulse);
	const previous = meta.connecting as ConnectPulseResolvers<P> | undefined;
	const previousState = previous && tasks.get(previous);
	if (
		previous &&
		(!previousState?.settled ||
			(previousState.succeeded &&
				meta.connections.every(
					(connection) => connection.active && established(connection),
				)))
	)
		return previous;
	const timeout = options.timeoutMs ?? meta.options.timeoutMs;
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new TypeError("timeoutMs must be positive");
	const ready = deferred<P>();
	const connected = deferred<P>();
	const synced = deferred<P>();
	const task = {
		ready: ready.promise,
		connected: connected.promise,
		synced: synced.promise,
	};
	const state = { settled: false, succeeded: false };
	tasks.set(task, state);
	if (meta.destroyed) {
		const error = new PulseError("CLOSED", "Pulse has been destroyed");
		ready.reject(error);
		connected.reject(error);
		synced.reject(error);
		state.settled = true;
		return task;
	}
	meta.connecting = task;
	const { connections } = meta;
	const locals = connections.filter(
		(connection) => connection.connector.kind === "local",
	);
	const attempted = new Set<Connection>();
	const downloaded = new Set<Connection>();
	for (const connection of connections)
		if (established(connection)) {
			attempted.add(connection);
			downloaded.add(connection);
		}
	const stops: (() => void)[] = [];
	let readyDone = false;
	let connectedDone = false;
	let remotesStarted = false;
	const isCurrent = () =>
		!state.settled && meta.connecting === task && !meta.destroyed;
	const finish = () => {
		state.settled = true;
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		if (meta.cancelConnection === cancel) meta.cancelConnection = undefined;
		for (const stop of stops.splice(0)) stop();
	};
	const fail = (
		error: Error,
		{ stop = false, report = true }: { stop?: boolean; report?: boolean } = {},
	) => {
		if (state.settled || meta.connecting !== task) return;
		finish();
		if (stop) {
			for (const connection of connections) connection.close();
			meta.connecting = undefined;
			meta.status = "error";
		} else refreshPulseStatus(meta);
		ready.reject(error);
		connected.reject(error);
		synced.reject(error);
		if (report) meta.report(error);
	};
	const cancel = (error: Error) => fail(error, { stop: true });
	const abort = () => cancel(new PulseError("CLOSED", "Connection aborted"));
	const timer = setTimeout(() => {
		const cause = connections.find(
			(connection) => connection.lastError,
		)?.lastError;
		fail(
			new PulseError(
				"TIMEOUT",
				cause
					? `Initial synchronization timed out: ${cause.message}`
					: "Initial synchronization timed out",
				{ cause },
			),
		);
	}, timeout);
	meta.cancelConnection = cancel;
	options.signal?.addEventListener("abort", abort, { once: true });

	const check = () => {
		if (!isCurrent()) return;
		refreshPulseStatus(meta);
		const localsTried = locals.every((connection) => attempted.has(connection));
		// Local connectors first, so remote sessions start from local history.
		if (localsTried && !remotesStarted) {
			remotesStarted = true;
			for (const connection of connections)
				if (connection.connector.kind !== "local") connection.start();
			if (!isCurrent()) return;
		}
		if (
			!readyDone &&
			meta.loaded &&
			(localsTried || locals.some((connection) => downloaded.has(connection)))
		) {
			readyDone = true;
			ready.resolve(pulse);
		}
		if (
			!connectedDone &&
			connections.every((connection) => downloaded.has(connection))
		) {
			if (!meta.loaded) {
				fail(new PulseError("NOT_FOUND", `Pulse ${meta.id} was not found`), {
					stop: true,
				});
				return;
			}
			connectedDone = true;
			readyDone = true;
			ready.resolve(pulse);
			connected.resolve(pulse);
		}
		if (
			connectedDone &&
			connections.every(
				(connection) =>
					connection.status === "synced" &&
					vectorCovers(connection.clockVector, meta.log.vector),
			)
		) {
			finish();
			state.succeeded = true;
			refreshPulseStatus(meta);
			synced.resolve(pulse);
		}
	};
	for (const connection of connections) {
		stops.push(
			connection.on("connected", () => {
				attempted.add(connection);
				downloaded.add(connection);
				check();
			}),
			connection.on("synced", check),
			connection.on("error", (error) => {
				attempted.add(connection);
				// A stopped connector fails the attempt; a retrying one may still succeed.
				if (connection.status === "error") fail(error, { report: false });
				else check();
			}),
		);
	}
	if (options.signal?.aborted) abort();
	else {
		for (const connection of locals) connection.start();
		check();
	}
	return task;
}
