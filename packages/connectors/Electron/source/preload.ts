import {
	channelsOf,
	DEFAULT_CHANNEL,
	DEFAULT_KEY,
	type PulsifyBridge,
	type PulsifyIpcResult,
} from "./bridge.js";

/** The subset of Electron's `ipcRenderer` used by Pulsify. */
export type ElectronIpcRenderer = {
	invoke(channel: string, ...args: any[]): Promise<any>;
	on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
	removeListener(channel: string, listener: (...args: any[]) => void): unknown;
};
/** The subset of Electron's `contextBridge` used by Pulsify. */
export type ElectronContextBridge = {
	exposeInMainWorld(apiKey: string, api: any): void;
};
export type PulsifyBridgeOptions = {
	/** Global name of the bridge in the page. Defaults to `"pulsify"`. */
	key?: string;
	/** IPC channel prefix; must match `servePulsifyStore`. Defaults to `"pulsify"`. */
	channel?: string;
};

/** Build the bridge without exposing it, e.g. for windows without context isolation. */
export function createPulsifyBridge(
	ipcRenderer: ElectronIpcRenderer,
	channel = DEFAULT_CHANNEL,
): PulsifyBridge {
	const channels = channelsOf(channel);
	const subscribe = (
		name: string,
		listener: (event: unknown, ...args: any[]) => void,
	) => {
		ipcRenderer.on(name, listener);
		return () => {
			ipcRenderer.removeListener(name, listener);
		};
	};
	return Object.freeze({
		open: (session: string, docId: string): Promise<PulsifyIpcResult> =>
			ipcRenderer.invoke(channels.open, String(session), String(docId)),
		send: (session: string, frame: Uint8Array): Promise<PulsifyIpcResult> =>
			ipcRenderer.invoke(channels.send, String(session), frame),
		async close(session: string) {
			await ipcRenderer.invoke(channels.close, String(session));
		},
		onMessage: (listener: (session: string, frame: Uint8Array) => void) =>
			subscribe(
				channels.message,
				(_event, session: string, frame: Uint8Array) =>
					listener(session, frame),
			),
		onClose: (
			listener: (session: string, code: string, message: string) => void,
		) =>
			subscribe(
				channels.closed,
				(_event, session: string, code: string, message: string) =>
					listener(session, code, message),
			),
	});
}

/**
 * Call from a preload script: exposes binary frame IPC, never `ipcRenderer`
 * itself. Requires `contextIsolation` (Electron's default).
 */
export function exposePulsifyBridge(
	electron: {
		contextBridge: ElectronContextBridge;
		ipcRenderer: ElectronIpcRenderer;
	},
	options: PulsifyBridgeOptions = {},
): void {
	electron.contextBridge.exposeInMainWorld(
		options.key ?? DEFAULT_KEY,
		createPulsifyBridge(electron.ipcRenderer, options.channel),
	);
}
