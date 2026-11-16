export const DEFAULT_CHANNEL = "pulsify";
export const DEFAULT_KEY = "pulsify";

export type PulsifyChannels = {
	open: string;
	markDeleted: string;
	cached: string;
	send: string;
	close: string;
	message: string;
	closed: string;
};
export function channelsOf(channel: string): PulsifyChannels {
	return {
		open: `${channel}:open`,
		markDeleted: `${channel}:markDeleted`,
		cached: `${channel}:cached`,
		send: `${channel}:send`,
		close: `${channel}:close`,
		message: `${channel}:message`,
		closed: `${channel}:closed`,
	};
}

/** Errors cross IPC as data: Electron flattens rejected invocations into strings. */
export type PulsifyIpcResult =
	{ ok: true; found?: boolean } | { ok: false; code: string; message: string };

/**
 * The only surface exposed to the page. Session IDs are chosen by the renderer
 * so that listeners exist before the main process can push a frame.
 */
export type PulsifyBridge = {
	cached?(docId: string): Promise<PulsifyIpcResult>;
	markDeleted?(docId: string, frames: Uint8Array[]): Promise<PulsifyIpcResult>;
	open(session: string, docId: string): Promise<PulsifyIpcResult>;
	send(session: string, frame: Uint8Array): Promise<PulsifyIpcResult>;
	close(session: string): Promise<void>;
	onMessage(listener: (session: string, frame: Uint8Array) => void): () => void;
	onClose(
		listener: (session: string, code: string, message: string) => void,
	): () => void;
};
