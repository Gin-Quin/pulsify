import type { Pulse } from "../pulses/Pulse.js";
import { getPulseMeta } from "../pulses/PulseMeta.js";
import { PulseError, asPulseError } from "../protocol/errors.js";
import { deferred } from "../utilities/deferred.js";
import { vectorCovers } from "./PulseVersionVector.js";

export type ConnectPulseOptions = { signal?: AbortSignal; timeoutMs?: number };
export type ConnectPulseResolvers<P extends Pulse<any>> = {
	ready: Promise<P>;
	connected: Promise<P>;
	synced: Promise<P>;
};

export function connectPulse<P extends Pulse<any>>(
	pulse: P,
	options: ConnectPulseOptions = {},
): ConnectPulseResolvers<P> {
	const meta = getPulseMeta(pulse);
	if (meta.connecting) return meta.connecting;
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
	if (meta.destroyed) {
		const error = new PulseError("CLOSED", "Pulse has been destroyed");
		ready.reject(error);
		connected.reject(error);
		synced.reject(error);
		return task;
	}
	meta.connecting = task;
	meta.status = "syncing";
	for (const connection of meta.connections) connection.prepare();
	let finished = false;
	const isCurrent = () =>
		!finished && meta.connecting === task && !meta.destroyed;
	const cleanup = () => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		if (meta.cancelConnection === fail) meta.cancelConnection = undefined;
	};
	const fail = (error: Error) => {
		if (finished || meta.connecting !== task) return;
		finished = true;
		cleanup();
		meta.status = "error";
		for (const connection of meta.connections) {
			if (meta.connecting !== task) break;
			connection.close();
		}
		if (meta.connecting === task) meta.connecting = undefined;
		ready.reject(error);
		connected.reject(error);
		synced.reject(error);
		meta.report(error);
	};
	const abort = () => fail(new PulseError("CLOSED", "Connection aborted"));
	const timer = setTimeout(
		() => fail(new PulseError("TIMEOUT", "Initial synchronization timed out")),
		timeout,
	);
	meta.cancelConnection = fail;
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const checkReady = () => {
		if (meta.loaded && isCurrent()) {
			meta.status = "ready";
			ready.resolve(pulse);
		}
	};
	const initial = async () => {
		const failures: unknown[] = [];
		const uploads: Promise<void>[] = [];
		for (const kind of ["local", "remote"] as const) {
			if (!isCurrent()) return;
			const connections = meta.connections.filter(
				(connection) => connection.connector.kind === kind,
			);
			const results = await Promise.allSettled(
				connections.map(async (connection) => {
					await connection.connect();
					if (!isCurrent()) return;
					checkReady();
					const upload = connection.syncBack();
					void upload.catch(() => {});
					uploads.push(upload);
				}),
			);
			for (const result of results)
				if (result.status === "rejected") failures.push(result.reason);
			checkReady();
			if (!isCurrent()) return;
		}
		if (failures.length) throw asPulseError(failures[0]);
		if (!meta.loaded)
			throw new PulseError("NOT_FOUND", `Pulse ${meta.id} was not found`);
		connected.resolve(pulse);
		await Promise.all(uploads);
		while (
			isCurrent() &&
			meta.connections.some(
				(connection) => !vectorCovers(connection.clockVector, meta.log.vector),
			)
		) {
			await Promise.all(
				meta.connections.map((connection) => connection.syncBack()),
			);
		}
		if (!isCurrent()) return;
		meta.status = "synced";
		ready.resolve(pulse);
		synced.resolve(pulse);
		finished = true;
		cleanup();
	};
	if (!finished) void initial().catch((error) => fail(asPulseError(error)));
	return task;
}
