import {
	exportPulseUpdates,
	getPulseMeta,
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
test("real document creation, loading and offline edits through a persistent Rust relay", async () => {
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
	const connector: Connector = {
		kind: "remote",
		async open({ onMessage }) {
			receive = onMessage;
			return {
				close() {
					receive = undefined;
				},
				async send(bytes) {
					process.stdin.write(`${hex(bytes)}\n`);
					await process.stdin.flush();
				},
			};
		},
	};
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
		process.stdin.end();
		await pumping;
		expect(await process.exited).toBe(0);
	}
});

test("Rust expands grouped transport into byte-exact original rows without a document schema", async () => {
	const D = definePulse("RustRun", {
		_type: "object",
		fields: { value: "float64" },
	}).materialize();
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
