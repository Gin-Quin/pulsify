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
import { decodeMessage } from "../packages/pulse/source/connection/PulseMessage";

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
