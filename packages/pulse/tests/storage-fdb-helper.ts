import type {
	OrderedKeyValueDatabase,
	OrderedKeyValueTransaction,
} from "../source/storage/foundationdb.js";

type Reply = { id: number; result?: unknown; error?: string; code?: number };
/** Test adapter. FDB stores the actual data; no in-memory database substitutes are used. */
export class DockerFoundationDB implements OrderedKeyValueDatabase {
	private readonly process: Bun.Subprocess<"pipe", "pipe", "inherit">;
	private nextId = 0;
	private serial: Promise<unknown> = Promise.resolve();
	private readonly waiting = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void }
	>();
	constructor(container: string) {
		this.process = Bun.spawn(
			[
				"docker",
				"exec",
				"-i",
				"-e",
				"PYTHONPATH=/tmp/fdb-python",
				"-e",
				"LD_LIBRARY_PATH=/usr/lib",
				container,
				"python3",
				"-u",
				"/tmp/pulsify-fdb-test-bridge.py",
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "inherit" },
		);
		void this.read();
	}
	private async read(): Promise<void> {
		const reader = this.process.stdout.getReader(),
			decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			buffer += decoder.decode(part.value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const reply = JSON.parse(buffer.slice(0, newline)) as Reply;
				buffer = buffer.slice(newline + 1);
				const waiter = this.waiting.get(reply.id);
				this.waiting.delete(reply.id);
				if (reply.error)
					waiter?.reject(
						Object.assign(new Error(reply.error), { code: reply.code }),
					);
				else waiter?.resolve(reply.result);
			}
		}
		for (const waiter of this.waiting.values())
			waiter.reject(new Error("FoundationDB bridge closed"));
	}
	private call(
		op: string,
		values: Record<string, unknown> = {},
	): Promise<unknown> {
		const id = this.nextId++;
		const response = new Promise<unknown>((resolve, reject) => {
			this.waiting.set(id, { resolve, reject });
		});
		this.process.stdin.write(`${JSON.stringify({ id, op, ...values })}\n`);
		return response;
	}
	transact<T>(
		work: (tx: OrderedKeyValueTransaction) => Promise<T>,
	): Promise<T> {
		const task = this.serial.then(async () => {
			for (let attempt = 0; ; attempt++) {
				await this.call("begin");
				try {
					const tx: OrderedKeyValueTransaction = {
						get: async (key) => {
							const value = await this.call("get", {
								key: Buffer.from(key).toString("base64"),
							});
							return typeof value === "string"
								? new Uint8Array(Buffer.from(value, "base64"))
								: undefined;
						},
						range: async (begin, end, options = {}) => {
							const result = (await this.call("range", {
								begin: Buffer.from(begin).toString("base64"),
								end: Buffer.from(end).toString("base64"),
								...options,
							})) as { key: string; value: string }[];
							return result.map((item) => ({
								key: new Uint8Array(Buffer.from(item.key, "base64")),
								value: new Uint8Array(Buffer.from(item.value, "base64")),
							}));
						},
						set: async (key, value) => {
							await this.call("set", {
								key: Buffer.from(key).toString("base64"),
								value: Buffer.from(value).toString("base64"),
							});
						},
						clear: async (key) => {
							await this.call("clear", {
								key: Buffer.from(key).toString("base64"),
							});
						},
					};
					const result = await work(tx);
					await this.call("commit");
					return result;
				} catch (error) {
					await this.call("cancel");
					if (
						attempt < 8 &&
						error instanceof Error &&
						"code" in error &&
						[1007, 1009, 1020, 1021].includes(error.code as number)
					)
						continue;
					throw error;
				}
			}
		});
		this.serial = task.catch(() => undefined);
		return task;
	}
	async close(): Promise<void> {
		await this.serial;
		this.process.stdin.end();
		await this.process.exited;
	}
}
