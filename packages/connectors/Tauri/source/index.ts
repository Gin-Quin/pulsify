import {
	Channel,
	invoke as tauriInvoke,
	type InvokeArgs,
	type InvokeOptions,
} from "@tauri-apps/api/core";
import {
	PulseError,
	type Connector,
	type ConnectorSession,
} from "pulsify-core";

type PulseErrorCode = PulseError["code"];
export type TauriInvoke = (
	command: string,
	args?: InvokeArgs,
	options?: InvokeOptions,
) => Promise<unknown>;
export type TauriConnectorOptions = {
	/** Defaults to `invoke` from `@tauri-apps/api/core`. */
	invoke?: TauriInvoke;
	/**
	 * Creates the IPC channel passed to the `open` command; defaults to a Tauri
	 * `Channel`. Raw frames arrive as `ArrayBuffer`s.
	 */
	createChannel?: (onMessage: (message: unknown) => void) => unknown;
	/** The name the Rust plugin was registered under. Defaults to `pulsify`. */
	plugin?: string;
};

/** Header carrying the session ID of a raw `send` invocation. */
export const TAURI_SESSION_HEADER = "pulsify-session";

const codes = new Set<string>([
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

/** Command failures are `{ code, message }` from the plugin, or strings from Tauri itself. */
function asPulseError(error: unknown): PulseError {
	if (error instanceof PulseError) return error;
	if (typeof error === "object" && error !== null) {
		const { code, message } = error as { code?: unknown; message?: unknown };
		if (typeof code === "string" && codes.has(code))
			return new PulseError(code as PulseErrorCode, String(message ?? code));
	}
	const message = error instanceof Error ? error.message : String(error);
	// Missing capability permissions will not heal by retrying.
	if (/not allowed|explicitly denied/.test(message))
		return new PulseError("FORBIDDEN", message, { cause: error });
	return new PulseError("CONNECTION_FAILED", message, { cause: error });
}

function toBytes(message: unknown): Uint8Array | undefined {
	if (message instanceof ArrayBuffer) return new Uint8Array(message);
	if (message instanceof Uint8Array) return message;
	if (Array.isArray(message)) return Uint8Array.from(message as number[]);
	return undefined;
}

/**
 * Local persistence through `tauri-plugin-pulsify`: every `open()` starts a
 * session on the app's SQLite database, pinned to one document. Rows stored
 * by one session reach the document's other sessions, in every window.
 */
export function createTauriConnector(
	options: TauriConnectorOptions = {},
): Connector {
	const invoke = options.invoke ?? tauriInvoke;
	const createChannel =
		options.createChannel ??
		((onMessage) => new Channel<ArrayBuffer>(onMessage));
	const command = (name: string) =>
		`plugin:${options.plugin ?? "pulsify"}|${name}`;
	return {
		kind: "local",
		// One pool of reusable actor IDs per plugin, and so per database.
		actorPool: `tauri:${options.plugin ?? "pulsify"}`,
		async open({ docId, signal, onMessage, onClose }) {
			if (signal.aborted) throw new PulseError("CLOSED", "Connection aborted");
			let closed = false;
			let sessionId: number | undefined;
			const release = () => {
				if (sessionId !== undefined)
					void invoke(command("close"), { sessionId }).catch(() => {});
			};
			const finish = (error?: PulseError) => {
				if (closed) return;
				closed = true;
				signal.removeEventListener("abort", abort);
				release();
				if (error) onClose(error);
			};
			const abort = () =>
				finish(new PulseError("CLOSED", "Connection aborted"));
			const channel = createChannel((message) => {
				if (closed) return;
				const bytes = toBytes(message);
				if (bytes) onMessage(bytes);
				else
					finish(new PulseError("INVALID_MESSAGE", "Expected a binary frame"));
			});
			signal.addEventListener("abort", abort, { once: true });
			try {
				const id = await invoke(command("open"), { docId, channel });
				if (typeof id !== "number")
					throw new PulseError("CONNECTION_FAILED", "Invalid session ID");
				sessionId = id;
			} catch (error) {
				finish();
				throw asPulseError(error);
			}
			if (closed) {
				release();
				throw new PulseError("CLOSED", "Connection aborted");
			}
			const headers = { [TAURI_SESSION_HEADER]: String(sessionId) };
			const session: ConnectorSession = {
				protocolVersion: 2,
				close: () => finish(),
				async send(bytes) {
					if (closed) throw new PulseError("CLOSED", "Connection closed");
					try {
						await invoke(command("send"), bytes, { headers });
					} catch (error) {
						const failure = asPulseError(error);
						if (
							failure.code === "CLOSED" ||
							failure.code === "CONNECTION_FAILED"
						)
							finish(failure);
						throw failure;
					}
				},
			};
			return session;
		},
	};
}
export {
	watchTauriPresence,
	type PresenceTarget,
	type TauriPresenceWindow,
} from "./presence.js";
