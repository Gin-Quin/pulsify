import {
	exportPulseUpdates,
	getPulseMeta,
	versioned,
} from "../packages/pulse/source/index.js";
import { expect, test } from "bun:test";
import fixtures from "../fixtures/protocol.json";
import {
	connectPulse,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	disconnectPulse,
	loadPulse,
	snapshotPulse,
	type Connector,
	type PulseProperties,
} from "../packages/pulse/source/index";
import {
	decodeMessage,
	encodeMessage,
} from "../packages/pulse/source/connection/PulseMessage";
import type { PulsePatchRow } from "../packages/pulse/source/connection/PulsePatch";
import { isGap } from "../packages/pulse/source/storage";
import { array, object } from "@gin-quin/codec";

const manifest = new URL(
	"../crates/pulsify-protocol/Cargo.toml",
	import.meta.url,
).pathname;
const binary = new URL(
	"../crates/pulsify-protocol/target/debug/pulsify-protocol",
	import.meta.url,
).pathname;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (line: string) => new Uint8Array(Buffer.from(line.trim(), "hex"));

// Build once, including the executable (cargo test only builds the test harness).
const build = Bun.spawnSync([
	"cargo",
	"build",
	"--locked",
	"--manifest-path",
	manifest,
]);
if (build.exitCode !== 0) throw new Error(build.stderr.toString());

test("TS encodings are decoded and re-encoded byte-for-byte by Rust", async () => {
	const input =
		fixtures.messages
			.map((fixture) => hex(new Uint8Array(fixture.bytes)))
			.join("\n") + "\n";
	const result = Bun.spawn([binary, "roundtrip"], {
		stdin: new Blob([input]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = await new Response(result.stdout).text();
	expect(await result.exited).toBe(0);
	expect(output.trim().split("\n")).toEqual(input.trim().split("\n"));
});
test("a message authored in Rust decodes with the expected TS type and values", () => {
	const result = Bun.spawnSync([binary, "sample"]);
	expect(result.exitCode).toBe(0);
	expect(decodeMessage(unhex(result.stdout.toString()))).toEqual({
		kind: 5,
		docId: "rust/🌍",
		requestId: 42,
		vv: [
			[65536, 128],
			[Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
		],
	});
});
/** The single-peer Rust relay, kept for a whole test: one session at a time. */
function startRelay() {
	const process = Bun.spawn([binary, "relay"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let receive: ((bytes: Uint8Array) => void) | undefined;
	const reader = process.stdout.getReader();
	const pumping = (async () => {
		const decoder = new TextDecoder();
		let buffered = "";
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			let end: number;
			while ((end = buffered.indexOf("\n")) >= 0) {
				const line = buffered.slice(0, end);
				buffered = buffered.slice(end + 1);
				if (line) receive?.(unhex(line));
			}
		}
	})();
	const send = async (bytes: Uint8Array) => {
		process.stdin.write(`${hex(bytes)}\n`);
		await process.stdin.flush();
	};
	const connector: Connector = {
		kind: "remote",
		async open({ onMessage }) {
			receive = onMessage;
			return {
				close() {
					receive = undefined;
				},
				send,
			};
		},
	};
	return {
		connector,
		/** The rows the relay sends to a peer that holds nothing. */
		async download(docId: string) {
			const rows: PulsePatchRow[] = [];
			const { promise, resolve } = Promise.withResolvers<void>();
			receive = (bytes) => {
				const reply = decodeMessage(bytes);
				if (reply.kind !== 2) throw new Error("Expected a sync frame");
				rows.push(...reply.rows);
				if (reply.complete) resolve();
			};
			await send(encodeMessage({ kind: 1, docId, requestId: 1, vv: [] }));
			await promise;
			receive = undefined;
			return rows;
		},
		async stop() {
			process.stdin.end();
			await pumping;
			return process.exited;
		},
	};
}

test("real document creation, loading and offline edits through a persistent Rust relay", async () => {
	const relay = startRelay();
	const { connector } = relay;
	type Doc = PulseProperties<"RustDoc"> & {
		title: string;
		nested: { count: number };
		items: number[];
	};
	const Doc = definePulse<Doc>("RustDoc").materialize();
	const first = createPulse(
		Doc,
		{
			id: "rust-document",
			title: "TS → Rust",
			nested: { count: 1 },
			items: [1, 2],
		},
		{ scope: createPulseScope(), connectors: [connector] },
	);
	try {
		await connectPulse(first).synced;
		disconnectPulse(first);
		const second = await loadPulse(Doc, first.id, {
			scope: createPulseScope(),
			connectors: [connector],
			waitFor: "all",
		});
		expect(snapshotPulse(second)).toEqual(snapshotPulse(first));
		disconnectPulse(second);
		second.nested.count = 7;
		second.items.push(3);
		await connectPulse(second).synced;
		disconnectPulse(second);
		await connectPulse(first).synced;
		expect(snapshotPulse(first)).toEqual(snapshotPulse(second));
		destroyPulse(second);
	} finally {
		destroyPulse(first);
		expect(await relay.stop()).toBe(0);
	}
});

test("the Rust relay keeps the last value only of a field that two replicas rewrite", async () => {
	const relay = startRelay();
	const { connector } = relay;
	const Doc = definePulse(
		"RustLastValue",
		object({
			title: "string",
			status: versioned("string"),
			items: array("string"),
		}),
	).materialize();
	const first = createPulse(
		Doc,
		{ id: "rust-last-value", title: "Draft", status: "open", items: [] },
		{ scope: createPulseScope(), connectors: [connector] },
	);
	// The relay serves one session at a time: replicas take turns.
	const sync = async (pulse: typeof first) => {
		await connectPulse(pulse).synced;
		disconnectPulse(pulse);
	};
	try {
		await sync(first);
		const second = await loadPulse(Doc, first.id, {
			scope: createPulseScope(),
			connectors: [connector],
			waitFor: "all",
		});
		disconnectPulse(second);
		const rounds = 60;
		for (let i = 0; i < rounds; i++) {
			// Both write before either hears of the other: the later upload wins
			// or arrives already replaced.
			for (let n = 0; n < 3; n++) {
				first.title = `first ${i}.${n}`;
				second.title = `second ${i}.${n}`;
			}
			if (i % 4 === 0) first.items.push(`item ${i}`);
			if (i % 6 === 0) second.status = `status ${i}`;
			await sync(i % 2 ? first : second);
			await sync(i % 2 ? second : first);
			await sync(i % 2 ? first : second);
			expect(snapshotPulse(first)).toEqual(snapshotPulse(second));
		}
		// The creation, one title, and every write to the sequence and to the
		// versioned field; at most one gap row per replica.
		const kept = 2 + rounds / 4 + rounds / 6;
		const rows = await relay.download(first.id);
		expect(rows.length).toBeGreaterThanOrEqual(kept);
		expect(rows.length).toBeLessThanOrEqual(kept + 3);
		expect(rows.filter((row) => isGap(row.operations)).length).toBeLessThan(3);
		const next = new Map<number, number>();
		for (const row of rows) {
			expect(row.clock).toBe(next.get(row.sid) ?? 1);
			next.set(row.sid, row.clock + row.span);
		}
		expect([...next].sort((a, b) => a[0] - b[0])).toEqual(
			getPulseMeta(first).log.vector,
		);
		const fresh = await loadPulse(Doc, first.id, {
			scope: createPulseScope(),
			connectors: [connector],
			waitFor: "all",
		});
		expect(snapshotPulse(fresh)).toEqual(snapshotPulse(first));
		expect(fresh.items.length).toBe(rounds / 4);
		destroyPulse(fresh);
		destroyPulse(second);
	} finally {
		destroyPulse(first);
		expect(await relay.stop()).toBe(0);
	}
});

test("Rust expands grouped transport into byte-exact original rows without a document schema", async () => {
	// Every write of a versioned field is kept, so a run of them is grouped.
	const D = definePulse(
		"RustRun",
		versioned({ _type: "object", fields: { value: "float64" } }),
	).materialize();
	const pulse = createPulse(
		D,
		{ id: "rust-run/🌍", value: 0 },
		{ scope: createPulseScope(), sessionId: 65536 },
	);
	try {
		const meta = getPulseMeta(pulse),
			vv = meta.log.vector;
		const initial = exportPulseUpdates(pulse, [], {
			kind: 3,
			requestId: 2,
			peerVersion: 2,
		});
		for (let i = 1; i <= 100; i++) pulse.value = i;
		const frame = exportPulseUpdates(pulse, vv, { peerVersion: 2 })[0]!;
		expect(frame[0]).toBe(2);
		const process = Bun.spawn([binary, "roundtrip"], {
			stdin: new Blob([hex(frame) + "\n"]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(process.stdout).text();
		expect(await process.exited).toBe(0);
		const message = decodeMessage(unhex(output));
		expect(message.kind).toBe(4);
		if (!("rows" in message)) throw Error();
		expect(message.rows).toEqual(meta.log.missing(vv));
		const connect = (requestId: number) =>
			encodeMessage({ kind: 1, docId: pulse.id, requestId, vv: [] });
		const upload = exportPulseUpdates(pulse, vv, {
			kind: 3,
			requestId: 3,
			peerVersion: 2,
		});
		const relay = Bun.spawn([binary, "relay"], {
			stdin: new Blob([
				[connect(1), ...initial, ...upload, connect(4)].map(hex).join("\n") +
					"\n",
			]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const replies = (await new Response(relay.stdout).text())
			.trim()
			.split("\n")
			.map((line) => decodeMessage(unhex(line)));
		expect(await relay.exited).toBe(0);
		const loaded = replies.find(
			(reply) => reply.kind === 2 && reply.requestId === 4,
		)!;
		expect(loaded.kind).toBe(2);
		if (!("rows" in loaded)) throw Error();
		expect(loaded.rows).toEqual(meta.log.missing([]));

		for (const mutated of [
			frame.subarray(0, frame.length - 1),
			new Uint8Array([...frame, 0]),
		]) {
			const p = Bun.spawn([binary, "roundtrip"], {
				stdin: new Blob([hex(mutated) + "\n"]),
				stdout: "pipe",
				stderr: "pipe",
			});
			await new Response(p.stdout).text();
			await new Response(p.stderr).text();
			expect(await p.exited).not.toBe(0);
		}
	} finally {
		destroyPulse(pulse);
	}
});
