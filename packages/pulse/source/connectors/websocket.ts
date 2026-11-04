import type { Connector, ConnectorSession } from "../connection/Connector.js";
import { MAX_FRAME_BYTES } from "../protocol/limits.js";
import { PulseError } from "../protocol/errors.js";

/** Supply a factory for runtimes without a global WebSocket or custom authentication. */
export function createWebSocketConnector(
	url: string,
	createSocket: (url: string, protocols?: string[]) => WebSocket = (
		url,
		protocols,
	) => new WebSocket(url, protocols),
	options: { protocolVersion?: 1 | 2 | 3 } = {},
): Connector {
	return {
		kind: "remote",
		open({ signal, onMessage, onClose }): Promise<ConnectorSession> {
			return new Promise((resolve, reject) => {
				if (signal.aborted) {
					reject(new PulseError("CLOSED", "Connection aborted"));
					return;
				}
				const socket =
					options.protocolVersion === 3
						? createSocket(url, ["pulsify-v3", "pulsify-v2", "pulsify-v1"])
						: options.protocolVersion === 2
							? createSocket(url, ["pulsify-v2", "pulsify-v1"])
							: createSocket(url);
				socket.binaryType = "arraybuffer";
				let opened = false;
				let closed = false;
				const cleanup = () => {
					signal.removeEventListener("abort", abort);
					socket.removeEventListener("open", open);
					socket.removeEventListener("message", message);
					socket.removeEventListener("error", error);
					socket.removeEventListener("close", close);
				};
				const finish = (failure?: Error) => {
					if (closed) return;
					closed = true;
					cleanup();
					if (!opened)
						reject(
							failure ??
								new PulseError("CLOSED", "WebSocket closed before opening"),
						);
					onClose(failure);
				};
				const abort = () => {
					finish(new PulseError("CLOSED", "Connection aborted"));
					socket.close();
				};
				const open = () => {
					opened = true;
					resolve({
						protocolVersion:
							options.protocolVersion === 3 && socket.protocol === "pulsify-v3"
								? 3
								: (options.protocolVersion ?? 1) >= 2 &&
										socket.protocol === "pulsify-v2"
									? 2
									: 1,
						close() {
							if (closed) return;
							finish();
							socket.close();
						},
						async send(bytes) {
							if (closed || socket.readyState !== 1)
								throw new PulseError("CLOSED", "WebSocket is not open");
							if (socket.bufferedAmount + bytes.length > 2 * MAX_FRAME_BYTES)
								throw new PulseError(
									"LIMIT_EXCEEDED",
									"WebSocket output buffer exceeded",
								);
							socket.send(bytes);
						},
					});
				};
				const message = (event: MessageEvent) => {
					if (!(event.data instanceof ArrayBuffer)) {
						finish(
							new PulseError(
								"INVALID_MESSAGE",
								"Expected binary WebSocket frame",
							),
						);
						socket.close();
						return;
					}
					onMessage(new Uint8Array(event.data));
				};
				const error = () => {
					finish(new PulseError("CONNECTION_FAILED", "WebSocket error"));
					socket.close();
				};
				const close = () =>
					finish(new PulseError("CLOSED", "WebSocket closed"));
				signal.addEventListener("abort", abort, { once: true });
				socket.addEventListener("open", open);
				socket.addEventListener("message", message);
				socket.addEventListener("error", error);
				socket.addEventListener("close", close);
			});
		},
	};
}
