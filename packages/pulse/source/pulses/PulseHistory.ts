import type { PulsePatchRow } from "../connection/PulsePatch.js";
import { decodeMessage } from "../connection/PulseMessage.js";
import {
	mergeVectors,
	validateVector,
	vectorCovers,
	type PulseVersionVector,
} from "../connection/PulseVersionVector.js";
import { CoreModel, type CoreNode } from "../core/model.js";
import {
	CorePatch,
	encodeCorePatch,
	type CoreOperation,
} from "../core/operations.js";
import { PulseError } from "../protocol/errors.js";
import { MAX_PATCH_BYTES, MAX_RANGE_MARKS } from "../protocol/limits.js";
import { randomActor } from "./actors.js";
import { destroyPulse, type Pulse, type PulseSnapshot } from "./Pulse.js";
import type {
	AnyPulseDefinition,
	ModelFromDefinition,
} from "./PulseDefinition.js";
import { getPulseMeta, type PulseMeta } from "./PulseMeta.js";
import { createPulseScope, defaultPulseOptions } from "./PulseOptions.js";
import {
	orderRows,
	restoreSourceOf,
	type ReplayStep as Step,
} from "./PulseReplay.js";
import { createRuntime } from "./PulseRuntime.js";

/** A transaction the document's history holds, and the document once it is applied. */
export type PulseVersion = {
	/** The version: pass it to `snapshotPulse(pulse, { at })` or `restorePulse`. */
	version: PulseVersionVector;
	/**
	 * The actor that wrote the transaction: a number a client writes under,
	 * not a user. A server that authenticates its connections can say which
	 * account an actor belongs to, as Pulsify Cloud does (`actorSubject`).
	 */
	actor: number;
	/** The transaction's sequence number among those of its actor. */
	clock: number;
	/** The writer's clock in milliseconds, under `versioned(…, { timestamps: true })`. */
	time?: number;
	/**
	 * The transaction is a migration: Pulsify wrote it when a client loaded
	 * the document with a newer definition. Its actor is that client's, which
	 * ran the migration; nobody edited the document.
	 */
	migration?: true;
};
/** A bound is a date, compared with `time`, or a version. */
export type PulseHistoryOptions = {
	/** Versions written at or after a date, or that a version does not include. */
	since?: Date | PulseVersionVector;
	/** Versions written at or before a date, or that a version includes. */
	until?: Date | PulseVersionVector;
};

/** An empty model of the document, to replay its history into. */
function replica(meta: PulseMeta): CoreModel {
	const model = new CoreModel(
		0,
		meta.id,
		meta.definition.kind,
		meta.definition.migrations.length + 1,
		meta.definition.compiledSchema,
		meta.definition.schemas,
		meta.definition.migrationChain,
	);
	// A restore in the history rebuilds its root from the pulse's journal.
	model.restoreSource = meta.model.restoreSource;
	return model;
}

/** The transactions the journal holds, in the order every replica gives them. */
// ponytail: decodes the whole journal on every call; cache the order per
// journal size if a history panel on a long document needs it.
function timeline(meta: PulseMeta, model: CoreModel): Step[] {
	const log = meta.log;
	if (!vectorCovers(log.historyVector, log.vector))
		throw new PulseError(
			"HISTORY_UNAVAILABLE",
			"This pulse holds a state without its history: call recoverPulseHistory first",
		);
	// The journal also holds rows that wait for what they depend on: they
	// are no part of the document yet.
	const applied = new Map(log.vector);
	return orderRows(
		log.missing([]).filter((row) => row.clock < (applied.get(row.sid) ?? 0)),
		model,
	);
}

function bounded(options: PulseHistoryOptions): (step: Step) => boolean {
	const bound = (limit: Date | PulseVersionVector | undefined) => {
		if (limit === undefined || limit instanceof Date) return limit?.getTime();
		validateVector(limit);
		return new Map(limit);
	};
	const since = bound(options.since),
		until = bound(options.until);
	const included = (step: Step, clocks: Map<number, number>) =>
		step.row.clock < (clocks.get(step.row.sid) ?? 0);
	return (step) =>
		(since === undefined ||
			(typeof since === "number"
				? step.time !== undefined && step.time >= since
				: !included(step, since))) &&
		(until === undefined ||
			(typeof until === "number"
				? step.time !== undefined && step.time <= until
				: included(step, until)));
}

const published = ({
	version,
	actor,
	row,
	time,
	migration,
}: Step): PulseVersion => ({
	version,
	actor,
	clock: row.clock,
	...(time === undefined ? {} : { time }),
	...(migration ? { migration } : {}),
});

/**
 * Apply a step to the replica, and say first whether it is a migration:
 * only one writes the schema version of the root.
 */
function replay(model: CoreModel, step: Step): void {
	const root = model.root;
	if (
		root &&
		step.patch.ops.some(
			(op) =>
				op.kind === 1 &&
				op.target === root.id &&
				model.fieldKey(root, op.field) === "version",
		)
	)
		step.migration = true;
	model.apply(step.patch);
}

/**
 * The versions of a document, oldest first: one per transaction its history
 * holds. With a key (or a path of keys), the writes of that field and the
 * value each one gave it; the field must be `versioned()` or a text, since
 * any other field keeps its last value only.
 */
export function getPulseHistory(
	pulse: Pulse<any>,
	options?: PulseHistoryOptions,
): PulseVersion[];
export function getPulseHistory<P extends Pulse<any>, Key extends keyof P>(
	pulse: P,
	key: Key & string,
	options?: PulseHistoryOptions,
): (PulseVersion & { value: PulseSnapshot<P[Key]> | undefined })[];
export function getPulseHistory(
	pulse: Pulse<any>,
	path: readonly string[],
	options?: PulseHistoryOptions,
): (PulseVersion & { value: unknown })[];
export function getPulseHistory(
	pulse: Pulse<any>,
	target?: string | readonly string[] | PulseHistoryOptions,
	options?: PulseHistoryOptions,
): PulseVersion[] {
	const meta = getPulseMeta(pulse);
	if (meta.destroyed)
		throw new PulseError("CLOSED", "Pulse has been destroyed");
	const path =
		typeof target === "string"
			? [target]
			: Array.isArray(target)
				? (target as readonly string[])
				: undefined;
	const keep = bounded(
		(path ? options : (target as PulseHistoryOptions | undefined)) ?? {},
	);
	const model = replica(meta);
	if (!path) {
		const steps = timeline(meta, model);
		// Only a definition that has migrations can have written one.
		if (meta.definition.migrations.length)
			for (const step of steps) replay(model, step);
		return steps.filter(keep).map(published);
	}
	if (!path.length) throw new TypeError("A field path cannot be empty");
	const compiled = meta.definition.compiledSchema;
	const layout =
		compiled?.fieldAt(path, meta.model.view())?.layout ??
		compiled?.layoutAt(path, meta.model.view());
	if (!layout || !(layout.versioned || layout.richText))
		throw new TypeError(
			`${path.join(".")} keeps its last value only: wrap it in versioned() to read its history`,
		);
	const key = path.at(-1)!;
	const result: (PulseVersion & { value: unknown })[] = [];
	let signature = "",
		last: unknown,
		written = false;
	for (const step of timeline(meta, model)) {
		replay(model, step);
		let node: CoreNode | undefined = model.root;
		for (let i = 0; node && i < path.length - 1; i++)
			node = node.child(path[i]!);
		const value: unknown =
			node && Object.hasOwn(node.data, key) ? node.data[key] : undefined;
		const current = node
			? `${node.id}|${node.stamps.get(key) ?? node.initialStamp}`
			: "";
		// An object, an array, a text or a counter changes below its field,
		// whose stamp stays: the transaction then addresses a node inside it.
		const held = node?.child(key);
		const inside = (target: CoreNode | undefined) => {
			for (; target && target !== held; target = target.parent) {
				// A value that was replaced still names the parent it had.
				const parent = target.parent,
					link = target.parentKey!;
				const entry = parent?.entries.get(link);
				if (
					!parent ||
					(parent.kind === "object"
						? parent.child(link) !== target
						: !entry || entry.deleted || entry.child !== target)
				)
					return false;
			}
			return target !== undefined;
		};
		const changed =
			current !== signature ||
			(held !== undefined &&
				step.patch.ops.some(
					(op) => "target" in op && inside(model.index.get(op.target)),
				)) ||
			((value === null || typeof value !== "object") &&
				!Object.is(value, last));
		signature = current;
		last = value;
		if (!changed || (value === undefined && !written)) continue;
		written = true;
		if (keep(step))
			result.push({
				...published(step),
				value: value === undefined ? undefined : layout.snapshot(value),
			});
	}
	return result;
}

/**
 * Pulses made here. All a copy writes is its own migrations, under an actor
 * of its own: its other rows are rows of the document it was made from.
 */
const copies = new WeakSet<PulseMeta>();
/** A pulse of its own scope, without connectors: nothing it holds leaves it. */
function detached(
	definition: AnyPulseDefinition,
	id: string,
	rows: PulsePatchRow[],
): Pulse<any> {
	const pulse = createRuntime(definition, id, {
		...defaultPulseOptions,
		connect: false,
		connectors: [],
		scope: createPulseScope(),
		// An explicit actor takes no lease, which a discarded scope would keep.
		sessionId: randomActor(),
	});
	copies.add(getPulseMeta(pulse));
	try {
		// Applying them also runs the migrations the document has not had yet.
		if (rows.length) getPulseMeta(pulse).applyRows(rows);
	} catch (error) {
		destroyPulse(pulse);
		throw error;
	}
	return pulse;
}

/** The version of the last transaction written by a date. */
function versionAt(meta: PulseMeta, date: Date): PulseVersionVector {
	if (!meta.definition.compiledSchema?.root.timestamps)
		throw new TypeError(
			"A date needs the time of every write: use versioned(schema, { timestamps: true })",
		);
	const time = date.getTime();
	// Up to the first transaction written after the date: one without a
	// time, written before the root recorded them, stays with those around it.
	const steps = timeline(meta, replica(meta));
	const after = steps.findIndex(
		(candidate) => candidate.time !== undefined && candidate.time > time,
	);
	const step = steps.at(after < 0 ? -1 : after - 1);
	if (!step || after === 0)
		throw new PulseError(
			"HISTORY_UNAVAILABLE",
			"The document has no version that old",
		);
	return step.version;
}

/**
 * The document at a past version, as a detached pulse the caller destroys.
 * Exact only where every write is kept: the schema must be `versioned()`.
 */
export function pulseAt(
	meta: PulseMeta,
	at: Date | PulseVersionVector,
): Pulse<any> {
	if (meta.destroyed)
		throw new PulseError("CLOSED", "Pulse has been destroyed");
	if (!meta.definition.compiledSchema?.root.versioned)
		throw new TypeError(
			"A past version needs every write: wrap the document's schema in versioned()",
		);
	const cut = at instanceof Date ? versionAt(meta, at) : at;
	validateVector(cut);
	if (!vectorCovers(meta.log.vector, cut))
		throw new PulseError(
			"HISTORY_UNAVAILABLE",
			"This pulse has not received that version",
		);
	if (!vectorCovers(meta.log.historyVector, meta.log.vector))
		throw new PulseError(
			"HISTORY_UNAVAILABLE",
			"This pulse holds a state without its history: call recoverPulseHistory first",
		);
	const clocks = new Map(cut);
	const pulse = detached(
		meta.definition,
		meta.id,
		meta.log
			.missing([])
			.filter((row) => row.clock < (clocks.get(row.sid) ?? 0)),
	);
	const past = getPulseMeta(pulse);
	if (!past.loaded || past.log.pendingCount) {
		destroyPulse(pulse);
		throw new PulseError(
			"HISTORY_UNAVAILABLE",
			"That vector is not a version of this document",
		);
	}
	return pulse;
}

/**
 * Open a saved copy of a document: the frames of
 * `exportPulseUpdates(pulse, [])`, or a snapshot of Pulsify Cloud. The pulse
 * is read-only, belongs to no scope and has no connector, and the migrations
 * added since the copy was made are applied to it. Read it, render it, or
 * give it to `restorePulse`; destroy it when done.
 */
export function openPulseSnapshot<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: string,
	frames: readonly Uint8Array[],
): Pulse<ModelFromDefinition<Definition>> {
	// Every row at once: migrations run on the whole copy, not on what a
	// first frame happens to hold.
	const rows: PulsePatchRow[] = [];
	for (const bytes of frames) {
		const message = decodeMessage(bytes);
		if (message.docId !== id || !("rows" in message))
			throw new PulseError("INVALID_MESSAGE", "Expected document update");
		for (const row of message.rows) rows.push(row);
	}
	const pulse = detached(definition, id, rows);
	const meta = getPulseMeta(pulse);
	if (!meta.loaded || meta.log.pendingCount) {
		destroyPulse(pulse);
		throw new PulseError(
			"INVALID_MESSAGE",
			"The frames do not hold a complete document",
		);
	}
	meta.model.commit = meta.model.commitScalar = () => {
		throw new PulseError("FORBIDDEN", "A snapshot is read-only");
	};
	return pulse as Pulse<ModelFromDefinition<Definition>>;
}

/** More than a value encodes to. */
function roughSize(value: unknown): number {
	if (typeof value === "string") return value.length * 3 + 4;
	if (value instanceof Uint8Array) return value.length + 4;
	if (!value || typeof value !== "object") return 16;
	let size = 8;
	for (const [key, item] of Object.entries(value))
		size += key.length * 3 + 4 + roughSize(item);
	return size;
}

/** Transactions of ranges, each within half a patch and what ranges may write. */
const BATCH_BYTES = MAX_PATCH_BYTES / 2;
function batches(
	ops: Extract<CoreOperation, { kind: 5 }>[],
): CoreOperation[][] {
	const result: CoreOperation[][] = [[]];
	let bytes = 0,
		marks = 0;
	for (const op of ops) {
		const size =
			op.target.length + op.entries[0]!.length + roughSize(op.attributes) + 16;
		const written = op.count! * Math.max(1, Object.keys(op.attributes).length);
		if (
			result.at(-1)!.length &&
			(bytes + size > BATCH_BYTES || marks + written > MAX_RANGE_MARKS)
		) {
			result.push([]);
			bytes = marks = 0;
		}
		result.at(-1)!.push(op);
		bytes += size;
		marks += written;
	}
	return result;
}

/**
 * What a receiver checks, before anything is written: a restore that
 * another replica would refuse must never enter the journal, where it would
 * keep the document from loading.
 */
function accepted(
	meta: PulseMeta,
	transactions: CoreOperation[][],
	time: number | undefined,
): void {
	const model = meta.model,
		sid = model.sid;
	let clock = model.nextClock,
		lamport = model.lamport + 1,
		dependencies = meta.log.vector;
	const patches: CorePatch[] = [];
	const covered = new Map<CorePatch, PulseVersionVector>();
	for (const ops of transactions) {
		const patch = new CorePatch(
			sid,
			clock,
			lamport++,
			model.schemaId,
			ops,
			time,
		);
		encodeCorePatch(patch, model.encoding);
		patches.push(patch);
		covered.set(patch, dependencies);
		dependencies = mergeVectors(dependencies, [[sid, ++clock]]);
	}
	model.validate(patches, covered);
}

/**
 * Restore by naming the version: one small operation, and every replica
 * builds the root from its own journal. False when that cannot be: a write
 * that replaced another below the version, history this journal does not
 * hold, or a root a receiver would not accept.
 */
function restoreVersion(
	meta: PulseMeta,
	version: PulseVersionVector,
	generation: number,
): boolean {
	validateVector(version);
	if (!vectorCovers(meta.log.vector, version)) return false;
	const restore = (): CoreOperation[] => [{ kind: 10, version, generation }];
	try {
		if (!meta.model.restoreSource?.(version)) return false;
		accepted(meta, [restore()], undefined);
	} catch {
		meta.forgetRestore(version);
		return false;
	}
	meta.model.commit(restore());
	// The root has the schema version it had then.
	meta.migrate();
	return true;
}

/** Restore by sending the content: a new root, then the formatting of its texts. */
function restoreContent(
	meta: PulseMeta,
	origin: PulseMeta,
	generation: number,
): void {
	const latest = meta.definition.migrations.length + 1;
	if (
		origin.definition !== meta.definition ||
		!origin.model.root ||
		origin.model.view().version !== latest
	)
		throw new PulseError(
			"INCOMPATIBLE_DOCUMENT",
			"A document is restored from a loaded pulse of its own definition",
		);
	const model = meta.model;
	const source = restoreSourceOf(origin.model.root);
	const value = {
		...source.value,
		id: meta.id,
		kind: meta.definition.kind,
		version: latest,
		generation,
	};
	model.validateRoot(value, model.schemaId);
	const root = (): CoreOperation => {
		const prepared = model.prepareRootInput(value);
		// Without a schema, nothing else says which strings are texts.
		return {
			kind: 0,
			value: model.compiled
				? prepared
				: { ...prepared, texts: source.texts.map(({ path }) => path) },
		};
	};
	// Building the root apart gives the IDs its nodes will have, so their
	// formatting is written in the same transaction, as ranges of them.
	const draft = replica(meta);
	draft.apply(
		new CorePatch(
			model.sid,
			model.nextClock,
			model.lamport + 1,
			model.schemaId,
			[root()],
		),
	);
	const marks: Extract<CoreOperation, { kind: 5 }>[] = [];
	const deletes: CoreOperation[] = [];
	for (const { path, runs, deleted } of source.texts) {
		let text: CoreNode | undefined = draft.root;
		for (const key of path)
			text =
				text?.kind === "object"
					? text.child(key)
					: text?.visible[Number(key)]?.child;
		if (text?.kind !== "text") continue;
		const target = text;
		if (deleted.length)
			deletes.push({
				kind: 3,
				target: target.id,
				after: "",
				deletes: deleted.map((index) => target.visible[index]!.id),
				values: [],
			});
		for (const { start, count, attributes } of runs) {
			// No more per operation than a transaction of ranges may write.
			const most = Math.max(
				1,
				Math.floor(
					MAX_RANGE_MARKS / Math.max(1, Object.keys(attributes).length),
				),
			);
			for (let done = 0; done < count; done += most)
				marks.push({
					kind: 5,
					target: text.id,
					entries: [text.visible[start + done]!.id],
					count: Math.min(most, count - done),
					attributes,
				});
		}
	}
	const [first, ...rest] = batches(marks);
	const time = model.compiled?.root.timestamps ? Date.now() : undefined;
	// A patch is only measured when it is sent: one that does not fit would
	// restore this replica and no other, so measure before writing.
	const fits = (ops: CoreOperation[]) => {
		try {
			encodeCorePatch(
				new CorePatch(0, 1, model.lamport + 1, model.schemaId, ops, time),
				model.encoding,
			);
			return true;
		} catch (error) {
			if (error instanceof PulseError && error.code === "LIMIT_EXCEEDED")
				return false;
			throw error;
		}
	};
	// ponytail: a range is a few bytes whatever its length, so the formatting
	// leaves the root's transaction only for a text whose formatting changes
	// tens of thousands of times, or holds very large values: a peer that
	// receives the next transactions apart shows the rest of the text
	// unformatted in between.
	const plan = (together: boolean): CoreOperation[][] => {
		const all = together
			? [[root(), ...first!], ...rest.map((ops) => [...ops])]
			: [[root()], [...first!], ...rest.map((ops) => [...ops])];
		// Deleted anchors go last: their attributes are written first.
		all.at(-1)!.push(...deletes);
		return all;
	};
	const together = plan(true).every(fits);
	const transactions = () => plan(together);
	if (!transactions().every(fits))
		throw new PulseError(
			"LIMIT_EXCEEDED",
			"A document restores in one transaction, which holds 1 MiB",
		);
	// Nothing is written unless every transaction would be accepted.
	accepted(meta, transactions(), time);
	for (const ops of transactions()) model.commit(ops, undefined, time);
}

/**
 * Give a document the content it had at a version or a date of its history,
 * or the content of a snapshot opened with `openPulseSnapshot`.
 *
 * A restore is a write like another: it travels to every replica and stays in
 * the history, so restoring the version before it undoes it. It replaces the
 * whole document by a new *generation* of it (`pulse.generation`), and edits
 * made to an earlier generation, on a replica that had not received the
 * restore yet, are discarded everywhere. Of two restores made apart, one wins
 * on every replica, with the edits that followed it. Objects, arrays and
 * texts read from the pulse before it are replaced: read them again, and
 * bind editors again.
 *
 * Where the document keeps every write up to that version, the restore only
 * names it and each replica rebuilds it from its own history. Otherwise it
 * carries the content, which must fit one transaction.
 */
export function restorePulse<P extends Pulse<any>>(
	pulse: P,
	source: Date | PulseVersionVector | NoInfer<P>,
): void {
	const meta = getPulseMeta(pulse);
	if (meta.destroyed)
		throw new PulseError("CLOSED", "Pulse has been destroyed");
	if (meta.deleted)
		throw new PulseError("NOT_FOUND", "Document was permanently deleted");
	if (!meta.loaded) throw new TypeError("Pulse is not loaded");
	const generation =
		((meta.model.view().generation as number | undefined) ?? 0) + 1;
	const held =
		source instanceof Date || Array.isArray(source)
			? undefined
			: getPulseMeta(source as Pulse<any>);
	// A copy: the operation is encoded when it is sent, and the caller's
	// array may have changed by then.
	const version = !held
		? source instanceof Date
			? versionAt(meta, source)
			: (source as PulseVersionVector).map(([sid, clock]): [number, number] => [
					sid,
					clock,
				])
		: held.id !== meta.id
			? undefined
			: copies.has(held)
				? held.log.vector.filter(([sid]) => sid !== held.options.sessionId)
				: held.log.vector;
	if (version && restoreVersion(meta, version, generation)) return;
	const past = held ? undefined : pulseAt(meta, version!);
	try {
		restoreContent(meta, held ?? getPulseMeta(past!), generation);
	} finally {
		if (past) destroyPulse(past);
	}
}
