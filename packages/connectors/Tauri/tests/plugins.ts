import { encodeBroadcast, PulseError, relayStoreMessage } from "pulsify-core";
import type { PatchStore } from "pulsify-core/storage";
import { TAURI_SESSION_HEADER, type TauriInvoke } from "../source/index";

/** Stands in for a Tauri `Channel`: the fake plugins call `onMessage` directly. */
export type FakeChannel = { onMessage(message: unknown): void };
export type FakePlugin = {
	invoke: TauriInvoke;
	createChannel(onMessage: (message: unknown) => void): FakeChannel;
};
const createChannel = (onMessage: (message: unknown) => void) => ({
	onMessage,
});
const sessionOf = (options: { headers?: HeadersInit } | undefined) =>
	Number(new Headers(options?.headers).get(TAURI_SESSION_HEADER));

/** The plugin's contract in TypeScript, over `relayStoreMessage` and any `PatchStore`. */
export function createStorePlugin(store: PatchStore) {
	const sessions = new Map<number, { docId: string; channel: FakeChannel }>();
	let nextSession = 1;
	const deliver = (channel: FakeChannel, frame: Uint8Array) => {
		const buffer = frame.slice().buffer;
		queueMicrotask(() => channel.onMessage(buffer));
	};
	const invoke: TauriInvoke = async (command, args, options) => {
		switch (command) {
			case "plugin:pulsify|open": {
				const { docId, channel } = args as {
					docId: string;
					channel: FakeChannel;
				};
				const id = nextSession++;
				sessions.set(id, { docId, channel });
				return id;
			}
			case "plugin:pulsify|send": {
				const id = sessionOf(options);
				const session = sessions.get(id);
				if (!session)
					throw { code: "CLOSED", message: "Unknown or closed session" };
				const result = await relayStoreMessage(store, args as Uint8Array, {
					docId: session.docId,
					protocolVersion: 2,
				});
				for (const frame of result.responses) deliver(session.channel, frame);
				if (result.broadcast)
					for (const [other, peer] of sessions)
						if (other !== id && peer.docId === result.docId)
							deliver(
								peer.channel,
								encodeBroadcast(result.docId, result.broadcast, 2),
							);
				return null;
			}
			case "plugin:pulsify|close":
				sessions.delete((args as { sessionId: number }).sessionId);
				return null;
		}
		throw new PulseError("INVALID_MESSAGE", `Unknown command ${command}`);
	};
	return { invoke, createChannel, sessions };
}

export const rustManifest = new URL(
	"../crates/pulsify-sqlite/Cargo.toml",
	import.meta.url,
).pathname;
const rustBinary = new URL(
	"../crates/pulsify-sqlite/target/debug/pulsify-sqlite",
	import.meta.url,
).pathname;

type Reply = { id: number; ok?: unknown; error?: unknown };
type Pending = {
	resolve(value: unknown): void;
	reject(error: unknown): void;
	channel?: FakeChannel;
};

/**
 * The real Rust hub over a SQLite file, driven like the Tauri plugin through JSON lines.
 * `binary` is another harness speaking the same lines, such as `pulsify-rocksdb`.
 */
export class RustPlugin implements FakePlugin {
	private readonly process: Bun.Subprocess<"pipe", "pipe", "inherit">;
	private readonly pending = new Map<number, Pending>();
	private readonly channels = new Map<number, FakeChannel>();
	private readonly pumping: Promise<void>;
	private nextRequest = 1;
	readonly createChannel = createChannel;

	constructor(database: string, binary = rustBinary) {
		this.process = Bun.spawn([binary, database], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		this.pumping = this.pump();
	}

	private async pump(): Promise<void> {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of this.process.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			let end: number;
			while ((end = buffered.indexOf("\n")) >= 0) {
				const line = buffered.slice(0, end);
				buffered = buffered.slice(end + 1);
				const message = JSON.parse(line) as
					Reply | { frame: number; hex: string };
				if ("frame" in message) {
					const bytes = new Uint8Array(Buffer.from(message.hex, "hex"));
					this.channels.get(message.frame)?.onMessage(bytes.buffer);
					continue;
				}
				const request = this.pending.get(message.id)!;
				this.pending.delete(message.id);
				if ("error" in message) request.reject(message.error);
				else {
					// Register before reading further lines, which may hold frames for it.
					if (request.channel)
						this.channels.set(message.ok as number, request.channel);
					request.resolve(message.ok);
				}
			}
		}
		for (const request of this.pending.values())
			request.reject({ code: "CLOSED", message: "Rust plugin exited" });
	}

	private request(command: unknown[], channel?: FakeChannel) {
		const id = this.nextRequest++;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, ...(channel && { channel }) });
			this.process.stdin.write(`${JSON.stringify([id, ...command])}\n`);
			void this.process.stdin.flush();
		});
	}

	readonly invoke: TauriInvoke = async (command, args, options) => {
		switch (command) {
			case "plugin:pulsify|open": {
				const { docId, channel } = args as {
					docId: string;
					channel: FakeChannel;
				};
				return this.request(["open", docId], channel);
			}
			case "plugin:pulsify|send":
				return this.request([
					"send",
					sessionOf(options),
					Buffer.from(args as Uint8Array).toString("hex"),
				]);
			case "plugin:pulsify|close": {
				const { sessionId } = args as { sessionId: number };
				this.channels.delete(sessionId);
				return this.request(["close", sessionId]);
			}
		}
		throw new PulseError("INVALID_MESSAGE", `Unknown command ${command}`);
	};

	schema(): Promise<unknown> {
		return this.request(["schema"]);
	}

	async stop(): Promise<number> {
		this.process.stdin.end();
		await this.pumping;
		return this.process.exited;
	}
}
