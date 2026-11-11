import type {
	ElectronContextBridge,
	ElectronIpcRenderer,
	PulsifyBridge,
} from "../source/index";
import type {
	ElectronIpcMain,
	ElectronIpcMainInvokeEvent,
	ElectronWebContents,
} from "../source/main";

type Listener = (...args: any[]) => void;
const hop = () => new Promise<void>((resolve) => setImmediate(resolve));

class Emitter {
	private readonly listeners = new Map<string, Set<Listener>>();
	on(event: string, listener: Listener): this {
		let set = this.listeners.get(event);
		if (!set) this.listeners.set(event, (set = new Set()));
		set.add(listener);
		return this;
	}
	removeListener(event: string, listener: Listener): this {
		this.listeners.get(event)?.delete(listener);
		return this;
	}
	emit(event: string, ...args: unknown[]): void {
		for (const listener of [...(this.listeners.get(event) ?? [])])
			listener(...args);
	}
	listenerCount(event?: string): number {
		if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
		let count = 0;
		for (const set of this.listeners.values()) count += set.size;
		return count;
	}
	removeAllListeners(): void {
		this.listeners.clear();
	}
}

/** Electron's `ipcMain.handle`, with structured clones and asynchronous hops. */
export class FakeIpcMain implements ElectronIpcMain {
	readonly handlers = new Map<
		string,
		(event: ElectronIpcMainInvokeEvent, ...args: any[]) => unknown
	>();
	readonly received: unknown[][] = [];
	handle(
		channel: string,
		listener: (event: ElectronIpcMainInvokeEvent, ...args: any[]) => unknown,
	): void {
		if (this.handlers.has(channel))
			throw new Error(
				`Attempted to register a second handler for '${channel}'`,
			);
		this.handlers.set(channel, listener);
	}
	removeHandler(channel: string): void {
		this.handlers.delete(channel);
	}
	async invoke(
		event: ElectronIpcMainInvokeEvent,
		channel: string,
		args: unknown[],
	): Promise<unknown> {
		const cloned = structuredClone(args);
		await hop();
		this.received.push([channel, ...cloned]);
		const handler = this.handlers.get(channel);
		if (!handler)
			throw new Error(
				`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`,
			);
		const result = await handler(event, ...cloned);
		await hop();
		return structuredClone(result);
	}
}

let nextId = 1;
export class FakeWebContents extends Emitter implements ElectronWebContents {
	readonly id = nextId++;
	destroyed = false;
	readonly sent: unknown[][] = [];
	readonly frames = new Map<number, FakeIpcRenderer>();
	isDestroyed(): boolean {
		return this.destroyed;
	}
	sendToFrame(
		frame: number | [processId: number, frameId: number],
		channel: string,
		...args: unknown[]
	): void {
		if (this.destroyed) throw new Error("Object has been destroyed");
		const frameId = typeof frame === "number" ? frame : frame[1];
		const cloned = structuredClone(args);
		this.sent.push([channel, ...cloned]);
		setImmediate(() => {
			if (!this.destroyed) this.frames.get(frameId)?.deliver(channel, cloned);
		});
	}
}

export class FakeIpcRenderer extends Emitter implements ElectronIpcRenderer {
	constructor(
		readonly ipcMain: FakeIpcMain,
		readonly webContents: FakeWebContents,
		readonly processId: number,
		readonly frameId: number,
	) {
		super();
	}
	invoke(channel: string, ...args: unknown[]): Promise<any> {
		if (this.webContents.destroyed)
			return Promise.reject(new Error("Render frame was disposed"));
		return this.ipcMain.invoke(
			{
				sender: this.webContents,
				processId: this.processId,
				frameId: this.frameId,
			},
			channel,
			args,
		);
	}
	deliver(channel: string, args: unknown[]): void {
		this.emit(channel, { sender: this }, ...args);
	}
}

/** A BrowserWindow: one WebContents, a main frame and optional subframes, each with a page world. */
export class FakeWindow {
	readonly webContents = new FakeWebContents();
	readonly worlds = new Map<number, Record<string, unknown>>();
	constructor(readonly ipcMain: FakeIpcMain) {
		this.frame(1);
	}
	frame(frameId: number): FakeIpcRenderer {
		let renderer = this.webContents.frames.get(frameId);
		if (!renderer) {
			renderer = new FakeIpcRenderer(
				this.ipcMain,
				this.webContents,
				7,
				frameId,
			);
			this.webContents.frames.set(frameId, renderer);
			this.worlds.set(frameId, {});
		}
		return renderer;
	}
	get ipcRenderer(): FakeIpcRenderer {
		return this.frame(1);
	}
	contextBridge(frameId = 1): ElectronContextBridge {
		return {
			exposeInMainWorld: (key, api) => {
				this.worlds.get(frameId)![key] = api;
			},
		};
	}
	bridge(key = "pulsify", frameId = 1): PulsifyBridge {
		return this.worlds.get(frameId)![key] as PulsifyBridge;
	}
	/** A main-frame reload: the page and its listeners are gone, the WebContents stays. */
	reload(): void {
		for (const renderer of this.webContents.frames.values())
			renderer.removeAllListeners();
		this.webContents.frames.clear();
		this.worlds.clear();
		this.webContents.emit(
			"did-frame-navigate",
			{},
			"app://",
			200,
			"OK",
			true,
			7,
			1,
		);
		this.frame(1);
	}
	navigateFrame(frameId: number): void {
		this.webContents.frames.get(frameId)?.removeAllListeners();
		this.webContents.frames.delete(frameId);
		this.worlds.delete(frameId);
		this.webContents.emit(
			"did-frame-navigate",
			{},
			"app://frame",
			200,
			"OK",
			false,
			7,
			frameId,
		);
		this.frame(frameId);
	}
	destroy(): void {
		this.webContents.destroyed = true;
		this.webContents.emit("destroyed");
	}
}
