import { expect, test } from "bun:test";
import { object, array } from "@gin-quin/codec";
import {
	createPulse,
	definePulse,
	createPulseScope,
	getPulseMeta,
	destroyPulse,
	snapshotPulse,
	exportPulseUpdates,
	applyPulseUpdates,
	decodeMessage,
	SUPPORTED_PROTOCOL_VERSIONS,
	type Pulse,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { PulseRelay } from "../source/protocol/PulseRelay.js";

const D = definePulse(
	"Compact",
	object({
		title: "string",
		nested: object({ count: "float64" }),
		items: array("string"),
	}),
).materialize();
const opts = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
const seed = () =>
	createPulse(
		D,
		{ id: "compact", title: "start", nested: { count: 0 }, items: [] },
		opts(65536),
	);
function join(source: Pulse<any>, sessionId: number) {
	const peer = createRuntime(D, "compact", opts(sessionId)) as ReturnType<
		typeof seed
	>;
	applyPulseUpdates(peer, exportPulseUpdates(source, []));
	return peer;
}
const vector = (pulse: Pulse<any>) => getPulseMeta(pulse).log.vector;
const rows = (pulse: Pulse<any>, base = vector(pulse)) =>
	getPulseMeta(pulse).log.missing(base);
const compact = (pulse: Pulse<any>, base: ReturnType<typeof vector>) =>
	exportPulseUpdates(pulse, base, { peerVersion: 4 });
const code = (run: () => unknown): string | undefined => {
	try {
		run();
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return undefined;
};

test("a lone scalar write travels as envelope 4 and rebuilds its exact row", () => {
	const a = seed(),
		b = join(a, 65537);
	try {
		expect(SUPPORTED_PROTOCOL_VERSIONS.at(-1)).toBe(4);
		const sizes: number[] = [];
		const edits: (() => unknown)[] = [
			() => (a.nested.count = 100),
			() => (a.nested.count = -1),
			() => (a.nested.count = 0.5),
			() => (a.title = "offline é🌍"),
			// Eight value bytes that also read as an integer float64 (near 2^52).
			() => (a.title = "abcde0C"),
		];
		for (const edit of edits) {
			const base = vector(a);
			edit();
			const frames = compact(a, base);
			expect(frames.map((frame) => frame[0])).toEqual([4]);
			sizes.push(frames[0]!.length);
			applyPulseUpdates(b, frames);
			// The receiver's journal holds the same bytes as the author's.
			expect(rows(b, base)).toEqual(rows(a, base));
			expect(vector(b)).toEqual(vector(a));
		}
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect(sizes).toEqual([21, 28, 28, 35, 28]);
		// A third peer receives the forwarded row from the receiver, not the author.
		const c = join(a, 65538);
		const before = vector(c);
		a.nested.count = 7;
		const forwarded = compact(a, before);
		applyPulseUpdates(b, forwarded);
		expect(compact(b, before)).toEqual(forwarded);
		destroyPulse(c);
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("stable compact bytes", () => {
	const a = seed();
	try {
		const base = vector(a);
		a.nested.count = 100;
		// 4, 3, flags, docId, sid, clock, lamport - clock, target, field, value
		expect([...compact(a, base)[0]!]).toEqual([
			4, 3, 16, 7, 99, 111, 109, 112, 97, 99, 116, 128, 128, 4, 2, 0, 0, 1, 1,
			0, 100,
		]);
	} finally {
		destroyPulse(a);
	}
});

test("concurrent compact writes converge in any order, duplicates included", () => {
	const a = seed(),
		peers = [65537, 65538, 65539].map((sid) => join(a, sid)),
		reference = join(a, 65600);
	try {
		const base = vector(peers[0]!);
		const updates = peers.map((peer, i) => {
			peer.nested.count = i + 1;
			return compact(peer, base);
		});
		// One external dependency names the creator of the target.
		expect(updates.map((frames) => frames[0]!.length)).toEqual([26, 26, 26]);
		for (const frames of updates) applyPulseUpdates(peers[0]!, frames);
		for (const frames of [...updates].reverse())
			applyPulseUpdates(reference, frames);
		expect(snapshotPulse(peers[0]!).nested).toEqual(
			snapshotPulse(reference).nested,
		);
		expect(rows(peers[0]!, base).length).toBe(3);
	} finally {
		for (const pulse of [a, reference, ...peers]) destroyPulse(pulse);
	}
});

test("anything but a lone scalar write keeps the earlier envelopes", () => {
	const a = seed();
	try {
		let base = vector(a);
		a.nested.count = 1;
		expect(exportPulseUpdates(a, base, { peerVersion: 3 })[0]![0]).toBe(1);
		expect(
			exportPulseUpdates(a, base, { peerVersion: 4, mode: "history" })[0]![0],
		).toBe(1);
		a.nested.count = 2;
		expect(compact(a, base)[0]![0]).toBe(1);
		base = vector(a);
		a.items.push("structural");
		expect(compact(a, base)[0]![0]).toBe(1);
		expect(compact(a, vector(a))[0]![0]).toBe(1);
		for (let i = 0; i < 40; i++) a.nested.count = i;
		expect(compact(a, [])[0]![0]).toBe(1);
	} finally {
		destroyPulse(a);
	}
});

test("compact frames are rejected without their pulse, target or canonical form", () => {
	const a = seed(),
		b = join(a, 65537),
		stranger = createRuntime(D, "compact", opts(65538)) as typeof a;
	try {
		const base = vector(a);
		a.nested.count = 100;
		const frame = compact(a, base)[0]!;
		const state = snapshotPulse(b);
		// Relays and stores never see envelope 4.
		expect(code(() => decodeMessage(frame))).toBe("UNSUPPORTED_VERSION");
		const peer = new PulseRelay().open(() => {}, { protocolVersion: 3 });
		expect(code(() => peer.receive(frame))).toBe("UNSUPPORTED_VERSION");
		expect(code(() => applyPulseUpdates(stranger, [frame]))).toBe(
			"HISTORY_UNAVAILABLE",
		);
		const edit = (change: (bytes: number[]) => number[]) =>
			code(() => applyPulseUpdates(b, [new Uint8Array(change([...frame]))]));
		const float = [0, 0, 0, 0, 0, 0, 89, 64];
		expect(edit((bytes) => [...bytes, 0])).toBe("INVALID_MESSAGE");
		expect(edit((bytes) => bytes.slice(0, -1))).toBe("INVALID_MESSAGE");
		expect(edit((bytes) => bytes.with(2, 32))).toBe("INVALID_MESSAGE");
		// The same integer as raw float64 bytes has a shorter canonical form.
		expect(edit((bytes) => [...bytes.with(2, 0).slice(0, -1), ...float])).toBe(
			"INVALID_MESSAGE",
		);
		// A value that does not fit the field's layout never reaches the journal.
		expect(edit((bytes) => [...bytes.with(2, 0).slice(0, -1), 1, 2, 3])).toBe(
			"INVALID_MESSAGE",
		);
		expect(snapshotPulse(b)).toEqual(state);
		expect(rows(b, base)).toEqual([]);
		applyPulseUpdates(b, [frame]);
		expect(b.nested.count).toBe(100);
		// The same frame again changes nothing; another value at its identity is a fork.
		applyPulseUpdates(b, [frame]);
		applyPulseUpdates(a, [frame]);
		expect(rows(b, base)).toEqual(rows(a, base));
		expect(edit((bytes) => bytes.with(-1, 99))).toBe("CONFLICT");
		expect(b.nested.count).toBe(100);
	} finally {
		for (const pulse of [a, b, stranger]) destroyPulse(pulse);
	}
});
