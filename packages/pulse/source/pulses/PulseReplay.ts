import { rowToPatch, type PulsePatchRow } from "../connection/PulsePatch.js";
import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import type {
	CoreEntry,
	CoreModel,
	CoreNode,
	RestoreSource,
} from "../core/model.js";
import type { CorePatch } from "../core/operations.js";
import {
	isRichTextNode,
	newerTextStamp,
	RT_NODE,
	RT_REDIRECT,
	RT_REMOVED,
} from "../core/richTextBinding.js";
import { PulseError } from "../protocol/errors.js";
import { isGapRow } from "../protocol/PatchLog.js";

/** A transaction of a journal, and the version of the document once it is applied. */
export type ReplayStep = {
	row: PulsePatchRow;
	patch: CorePatch;
	version: PulseVersionVector;
	actor: number;
	time?: number;
	/** Set by a history that replays its steps: see `PulseVersion.migration`. */
	migration?: true;
};

/**
 * Transactions in one order every replica agrees on: `(lamport, actor)`,
 * after everything a transaction depends on. Each prefix of it is a state
 * the document went through, or could have. Gap rows hold nothing to order.
 */
export function orderRows(
	rows: readonly PulsePatchRow[],
	model: CoreModel,
): ReplayStep[] {
	let waiting = rows
		.filter((row) => !isGapRow(row))
		.map((row) => ({
			row,
			patch: rowToPatch(row, (schema) => model.decodeEncoding(schema)),
		}))
		.sort(
			(a, b) =>
				a.patch.lamport - b.patch.lamport ||
				a.row.sid - b.row.sid ||
				a.row.clock - b.row.clock,
		);
	// The clocks each actor still has to give, oldest last.
	const held = new Map<number, number[]>();
	for (const { row } of waiting) {
		const clocks = held.get(row.sid);
		if (clocks) clocks.push(row.clock);
		else held.set(row.sid, [row.clock]);
	}
	for (const clocks of held.values()) clocks.sort((a, b) => b - a);
	const next = (sid: number) => held.get(sid)?.at(-1) ?? Infinity;
	const vector = new Map<number, number>();
	const steps: ReplayStep[] = [];
	while (waiting.length) {
		const later: typeof waiting = [];
		for (const item of waiting) {
			const { row, patch } = item;
			// A Lamport clock is the writer's word: dependencies decide.
			if (
				next(row.sid) !== row.clock ||
				row.dependencies.some(([sid, clock]) => next(sid) < clock)
			) {
				later.push(item);
				continue;
			}
			held.get(row.sid)!.pop();
			for (const [sid, clock] of row.dependencies)
				vector.set(sid, Math.max(vector.get(sid) ?? 0, clock));
			vector.set(row.sid, Math.max(vector.get(row.sid) ?? 0, row.clock + 1));
			steps.push({
				row,
				patch,
				version: [...vector].sort((a, b) => a[0] - b[0]),
				actor: row.sid,
				...(patch.time === undefined ? {} : { time: patch.time }),
			});
		}
		if (later.length === waiting.length)
			throw new PulseError(
				"HISTORY_UNAVAILABLE",
				"The journal holds transactions without what they depend on",
			);
		waiting = later;
	}
	return steps;
}

/** Objects with their keys sorted: insertion order differs between replicas. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== "object" || value instanceof Uint8Array)
		return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort())
		result[key] = canonical((value as Record<string, unknown>)[key]);
	return result;
}

/** Plain values as marks hold them: bytes and big integers included. */
function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	if (a instanceof Uint8Array || b instanceof Uint8Array)
		return (
			a instanceof Uint8Array &&
			b instanceof Uint8Array &&
			a.length === b.length &&
			a.every((byte, index) => byte === b[index])
		);
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every(
			(key) =>
				Object.hasOwn(b, key) &&
				sameValue(
					(a as Record<string, unknown>)[key],
					(b as Record<string, unknown>)[key],
				),
		)
	);
}

/**
 * The attributes each character of a text is restored with. They all get
 * the stamp of the restore, and stamps are what decides between the anchors
 * of one editor node (two replicas that bound an empty field at once, say):
 * the newest value of each attribute is given to every anchor that has it,
 * so that the choice no longer depends on a stamp. That follows what a
 * binding reads: a redirect from every anchor of the node, deleted ones
 * included, and any other attribute from the visible ones. Removal is not
 * decided by stamps: any anchor that says so removes the node. A deleted
 * anchor is kept for its redirect and its removal, and carries nothing else.
 */
function restoredAttributes(
	entries: readonly CoreEntry[],
): Record<string, unknown>[] {
	type Mark = { stamp: readonly [number, number, number]; value: unknown };
	const newest = new Map<string, Map<string, Mark>>();
	const idOf = (entry: CoreEntry) => entry.marks.get(RT_NODE)!.value as string;
	for (const entry of entries) {
		if (!isRichTextNode(entry)) continue;
		let node = newest.get(idOf(entry));
		if (!node) newest.set(idOf(entry), (node = new Map()));
		for (const [name, mark] of entry.marks) {
			if (entry.deleted && name !== RT_REDIRECT) continue;
			const held = node.get(name);
			if (!held || newerTextStamp(mark.stamp, held.stamp)) node.set(name, mark);
		}
	}
	return entries.map((entry) => {
		const node = isRichTextNode(entry) ? newest.get(idOf(entry)) : undefined;
		const attributes: Record<string, unknown> = {};
		for (const name of [...entry.marks.keys()].sort()) {
			const own = entry.marks.get(name)!;
			if (
				entry.deleted &&
				name !== RT_NODE &&
				name !== RT_REDIRECT &&
				name !== RT_REMOVED
			)
				continue;
			const value = (
				!node || name === RT_REMOVED || name === RT_NODE
					? own
					: (node.get(name) ?? own)
			).value;
			if (value !== null && value !== undefined) attributes[name] = value;
		}
		return attributes;
	});
}

/**
 * What a root is rebuilt from. A text is a string in its parent, and a
 * snapshot only has its projection: this value has all of its characters,
 * editor anchors included, and `texts` the attributes they carry.
 */
export function restoreSourceOf(root: CoreNode): RestoreSource {
	const value = structuredClone(root.data) as Record<string, unknown>;
	const texts: RestoreSource["texts"] = [];
	const visit = (node: CoreNode, plain: any, path: string[]) => {
		const child = (item: CoreNode | undefined, key: string | number) => {
			if (!item || item.layout?.counter) return;
			if (item.kind !== "text")
				return visit(item, plain[key], [...path, String(key)]);
			// What is visible, and the anchors a binding deleted that still say
			// where their node went (joining two blocks) or that it is removed:
			// both are read from deleted anchors too.
			const entries = item.order.filter(
				(entry) =>
					!entry.deleted ||
					(isRichTextNode(entry) &&
						(typeof entry.marks.get(RT_REDIRECT)?.value === "string" ||
							entry.marks.get(RT_REMOVED)?.value === true)),
			);
			plain[key] = entries.map((entry) => entry.value as string).join("");
			const deleted: number[] = [];
			entries.forEach((entry, index) => {
				if (entry.deleted) deleted.push(index);
			});
			// One run per stretch of characters that carry the same attributes.
			const runs: RestoreSource["texts"][number]["runs"] = [];
			restoredAttributes(entries).forEach((attributes, start) => {
				if (!Object.keys(attributes).length) return;
				const run = runs.at(-1);
				if (
					run &&
					run.start + run.count === start &&
					sameValue(run.attributes, attributes)
				)
					run.count++;
				else runs.push({ start, count: 1, attributes });
			});
			texts.push({ path: [...path, String(key)], runs, deleted });
		};
		if (node.kind === "object") {
			// Sorted like the value, so that texts come in one order everywhere.
			for (const key of [...node.children.keys()].sort())
				if (Object.hasOwn(plain, key)) child(node.child(key), key);
		} else node.visible.forEach((entry, index) => child(entry.child, index));
	};
	visit(root, value, []);
	return { value: canonical(value) as Record<string, unknown>, texts };
}

/**
 * The document at a version, from the rows of a journal: what a restore to
 * that version builds, on every replica alike. That takes every row below
 * the version: one write that replaced another there makes replicas hold
 * different rows, so the version cannot be restored this way.
 */
export function replayTo(
	rows: readonly PulsePatchRow[],
	version: PulseVersionVector,
	model: CoreModel,
): RestoreSource | undefined {
	const cuts = new Map(version);
	const below = rows.filter((row) => row.clock < (cuts.get(row.sid) ?? 0));
	const replaced = new PulseError(
		"INVALID_MESSAGE",
		"The document does not keep every write below that version",
	);
	const counts = new Map<number, number>();
	for (const row of below) {
		if (
			isGapRow(row) ||
			Math.min(row.clock + row.span, cuts.get(row.sid)!) > row.clock + 1
		)
			throw replaced;
		counts.set(row.sid, (counts.get(row.sid) ?? 0) + 1);
	}
	// One row per sequence number: anything less is history not received.
	for (const [sid, cut] of cuts)
		if ((counts.get(sid) ?? 0) !== cut - 1)
			throw new PulseError(
				"HISTORY_UNAVAILABLE",
				"The journal does not hold every row below that version",
			);
	for (const { patch } of orderRows(below, model)) {
		if (patch.ops.some((op) => (op.kind === 1 || op.kind === 2) && op.last))
			throw replaced;
		model.apply(patch);
	}
	return model.root ? restoreSourceOf(model.root) : undefined;
}
