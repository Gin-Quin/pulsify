import {
	PulseError,
	type Connector,
	type ConnectorSession,
} from "@pulsify/core";
import {
	DEFAULT_KEY,
	type PulsifyBridge,
	type PulsifyIpcResult,
} from "./bridge.js";

type PulseErrorCode = PulseError["code"];
const CODES = new Set<string>([
	"HISTORY_UNAVAILABLE",
	"INVALID_MESSAGE",
	"UNSUPPORTED_VERSION",
	"NOT_FOUND",
	"INCOMPATIBLE_DOCUMENT",
	"MIGRATION_DRIFT",
	"CLOSED",
	"TIMEOUT",
	"CONNECTION_FAILED",
	"CONFLICT",
	"LIMIT_EXCEEDED",
	"FORBIDDEN",
] satisfies PulseErrorCode[]);
function errorOf(result: { code: string; message: string }): PulseError {
	return new PulseError(
		CODES.has(result.code)
			? (result.code as PulseErrorCode)
			: "CONNECTION_FAILED",
		result.message,
	);
}
function unreachable(error: unknown): PulseError {
	return new PulseError(
		"CONNECTION_FAILED",
		"Cannot reach the Pulsify store in the main process",
		{ cause: error },
	);
}

const prefix = Math.random().toString(36).slice(2, 10);
let nextSession = 0;

/**
 * A local connector for Electron renderers, backed by `servePulsifyStore` in
 * the main process. Pass the bridge, or the global name it was exposed under.
 */
export function createElectronConnector(
	bridge: PulsifyBridge | string = DEFAULT_KEY,
): Connector {
	type Handlers = {
		message(frame: Uint8Array): void;
		close(error: PulseError): void;
	};
	const sessions = new Map<string, Handlers>();
	let target: PulsifyBridge | undefined;
	let unsubscribe: (() => void) | undefined;
	const resolve = () =>
		(target ??=
			typeof bridge === "string"
				? ((globalThis as Record<string, unknown>)[bridge] as
						PulsifyBridge | undefined)
				: bridge);
	const listen = (target: PulsifyBridge) => {
		if (unsubscribe) return;
		const messages = target.onMessage((id, frame) =>
			sessions.get(id)?.message(frame),
		);
		const closes = target.onClose((id, code, message) =>
			sessions.get(id)?.close(errorOf({ code, message })),
		);
		unsubscribe = () => {
			messages();
			closes();
		};
	};
	const forget = (id: string) => {
		sessions.delete(id);
		if (sessions.size) return;
		unsubscribe?.();
		unsubscribe = undefined;
	};

	return {
		kind: "local",
		open({ docId, signal, onMessage, onClose }): Promise<ConnectorSession> {
			return new Promise((resolveSession, reject) => {
				if (signal.aborted) {
					reject(new PulseError("CLOSED", "Connection aborted"));
					return;
				}
				const bridge = resolve();
				if (!bridge) {
					reject(
						new PulseError(
							"CONNECTION_FAILED",
							"Pulsify bridge not found: call exposePulsifyBridge() in the preload script",
						),
					);
					return;
				}
				const id = `${prefix}-${++nextSession}`;
				let answered = false;
				let opened = false;
				let closed = false;
				let early: Uint8Array[] | undefined = [];
				const finish = (error?: PulseError) => {
					if (closed) return;
					closed = true;
					forget(id);
					signal.removeEventListener("abort", abort);
					// Before the main process answers, closing could overtake the open.
					if (answered) void bridge.close(id).catch(() => {});
					if (!opened)
						reject(error ?? new PulseError("CLOSED", "Connection closed"));
					else if (error) onClose(error);
				};
				const abort = () =>
					finish(new PulseError("CLOSED", "Connection aborted"));
				signal.addEventListener("abort", abort, { once: true });
				sessions.set(id, {
					message(frame) {
						if (closed) return;
						if (early) early.push(frame);
						else onMessage(frame);
					},
					close: finish,
				});
				listen(bridge);
				const session: ConnectorSession = {
					protocolVersion: 2,
					close: () => finish(),
					async send(bytes) {
						if (closed) throw new PulseError("CLOSED", "Connection closed");
						let result: PulsifyIpcResult;
						try {
							result = await bridge.send(id, bytes);
						} catch (error) {
							const failure = unreachable(error);
							finish(failure);
							throw failure;
						}
						if (result.ok) return;
						const failure = errorOf(result);
						if (
							failure.code === "CLOSED" ||
							failure.code === "CONNECTION_FAILED"
						)
							finish(failure);
						throw failure;
					},
				};
				bridge.open(id, docId).then(
					(result) => {
						answered = true;
						if (closed) {
							if (result.ok) void bridge.close(id).catch(() => {});
							return;
						}
						if (!result.ok) {
							finish(errorOf(result));
							return;
						}
						opened = true;
						resolveSession(session);
						queueMicrotask(() => {
							const pending = early ?? [];
							early = undefined;
							for (const frame of pending) if (!closed) onMessage(frame);
						});
					},
					(error) => finish(unreachable(error)),
				);
			});
		},
	};
}
