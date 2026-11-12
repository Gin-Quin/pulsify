import { array, object } from "@gin-quin/codec";
import {
	applyPulseUpdates,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseVersions,
	getPulseMeta,
	snapshotPulse,
} from "../../packages/pulse/source/index.js";
import { createRuntime } from "../../packages/pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../../packages/pulse/source/pulses/PulseOptions.js";
import {
	decodeMessage,
	encodeMessage,
	type PulsePatchRow,
} from "../../packages/pulse/source/protocol.js";
import type { Vector } from "./types.js";

const definition = definePulse(
	"DatabaseBenchmark",
	object({
		title: "string",
		revision: "float64",
		metadata: object({ author: "string", published: "boolean" }),
		paragraphs: array(object({ id: "string", text: "string" })),
	}),
).materialize();
export const profiles = {
	small: { paragraphs: 8, textBytes: 256, patches: 20 },
	medium: { paragraphs: 64, textBytes: 512, patches: 100 },
	large: { paragraphs: 256, textBytes: 1024, patches: 1000 },
	// One document, three history lengths: only the number of edits differs.
	"edits-100": { paragraphs: 256, textBytes: 1024, patches: 100 },
	"edits-1000": { paragraphs: 256, textBytes: 1024, patches: 1000 },
	"edits-10000": { paragraphs: 256, textBytes: 1024, patches: 10000 },
};
export type Profile = keyof typeof profiles;
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
export function receiver(docId: string) {
	return createRuntime(definition, docId, options(79999));
}
export function applyRows(
	pulse: ReturnType<typeof receiver>,
	rows: PulsePatchRow[],
): void {
	if (rows.length)
		applyPulseUpdates(pulse, [
			encodeMessage({
				kind: 4,
				docId: getPulseMeta(pulse).id,
				requestId: 0,
				vv: [],
				rows,
			}),
		]);
}
function rowsFrom(frames: Uint8Array[]): PulsePatchRow[] {
	return frames.flatMap((frame) => {
		const message = decodeMessage(frame);
		if (!("rows" in message)) throw new Error("Expected patch rows");
		return message.rows;
	});
}

/** Deterministic content and actor schedule; only document IDs differ between samples. */
export function fixture(profile: Profile, docId: string = crypto.randomUUID()) {
	const config = profiles[profile];
	const words = [
		"document",
		"collaboration",
		"chapter",
		"storage",
		"reader",
		"revision",
		"history",
		"pulse",
		"vector",
		"editing",
		"author",
		"paragraph",
	];
	let seed = 20261104;
	const text = () => {
		let value = "";
		while (value.length < config.textBytes) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			value += `${words[seed % words.length]} `;
		}
		return value.slice(0, config.textBytes);
	};
	const original = createPulse(
		definition,
		{
			id: docId,
			title: "A collaborative manuscript",
			revision: 0,
			metadata: { author: "Pulsify benchmark", published: false },
			paragraphs: Array.from({ length: config.paragraphs }, (_, i) => ({
				id: `paragraph-${i}`,
				text: text(),
			})),
		},
		options(70001),
	);
	const initial = rowsFrom(
		exportPulseUpdates(original, [], { mode: "history" }),
	);
	const peers = [70002, 70003].map(
		(sid) => createRuntime(definition, docId, options(sid)) as typeof original,
	);
	for (const peer of peers) applyRows(peer, initial);
	const patches: PulsePatchRow[][] = [];
	const cutoff = Math.floor(config.patches * 0.9);
	let remote: Vector = [];
	try {
		for (let i = 0; i < config.patches; i++) {
			const peer = peers[i % peers.length]!;
			const before = getPulseVersions(peer).history;
			// Single scalar patch per edit, distributed over nested fields and paragraphs.
			if (i % 3 === 0) peer.revision = i + 1;
			else if (i % 3 === 1)
				peer.title = `A collaborative manuscript, revision ${i + 1}`;
			else
				peer.paragraphs[i % config.paragraphs]!.text =
					`Edited paragraph ${i + 1}: ${text()}`;
			const delta = rowsFrom(
				exportPulseUpdates(peer, before, { mode: "history" }),
			);
			patches.push(delta);
			for (const other of peers) if (other !== peer) applyRows(other, delta);
			if (i + 1 === cutoff) remote = getPulseVersions(peer).history;
		}
		return {
			docId,
			profile,
			initial,
			patches,
			remote,
			prefix: [...initial, ...patches.slice(0, cutoff).flat()],
			expected: snapshotPulse(peers[0]!),
			vector: getPulseVersions(peers[0]!).history,
		};
	} finally {
		destroyPulse(original);
		for (const peer of peers) destroyPulse(peer);
	}
}
export type Fixture = ReturnType<typeof fixture>;
