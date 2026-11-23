import type { SynchronizationStatus } from "../connection/SynchronizationStatus.js";
import { stateDeltaOf } from "../protocol/stateDeltas.js";
import { scalarRunOf, readRunValues } from "../protocol/scalarRuns.js";
import { sameScalarWrite } from "../protocol/stateExchange.js";
import { Connection } from "../connection/Connection.js";
import {
	patchToRow,
	rowToPatch,
	type PulsePatchRow,
} from "../connection/PulsePatch.js";
import {
	vectorCovers,
	type PulseVersionVector,
} from "../connection/PulseVersionVector.js";
import { CoreModel, managedFields, type RestoreSource } from "../core/model.js";
import {
	CorePatch,
	ScalarPatch,
	type CoreOperation,
	type CoreScalar,
} from "../core/operations.js";
import { prepareValue, type PreparedValue } from "../core/values.js";
import { containsMap } from "../core/schema.js";
import { PulseError, asPulseError } from "../protocol/errors.js";
import { isGapRow, PatchLog } from "../protocol/PatchLog.js";
import {
	actorPoolOf,
	leaseActor,
	leasedActor,
	randomActor,
	rememberActor,
} from "./actors.js";
import { bind as bindPulse, type Binding } from "./Bindings.js";
import type { Pulse } from "./Pulse.js";
import type { AnyPulseDefinition } from "./PulseDefinition.js";
import type { PulseMeta } from "./PulseMeta.js";
import { createObjectProxy } from "./PulseObject.js";
import type { PulseOptions } from "./PulseOptions.js";
import type { ProxyContext } from "./ProxyContext.js";
import { warnMigrationDrift } from "./warnMigrationDrift.js";
import { replayTo } from "./PulseReplay.js";
import { notifyScope } from "./scopeEvents.js";
import {
	containsSub,
	createSubPulseTracker,
	fieldLayoutOf,
	hasSubLayout,
	patchTouchesSub,
} from "./subPulses.js";
import { bumpNodeRevision, bumpPatchRevisions } from "./nodeRevisions.js";
import {
	invalidateCachedRef,
	invalidatePatchRefs,
} from "../utilities/pulsify.js";

export function createRuntime(
	definition: AnyPulseDefinition,
	id: string,
	options: PulseOptions,
	data?: Record<string, unknown>,
	/** `data` creates a document under an ID that was generated just now. */
	generated = false,
): Pulse<any> {
	if (
		typeof id !== "string" ||
		!id.length ||
		id.length > 1024 ||
		!id.isWellFormed() ||
		id.includes("\0")
	)
		throw new TypeError("Invalid pulse ID");
	const kind = definition.kind;
	if (typeof kind !== "string" || !kind.isWellFormed())
		throw new TypeError("Invalid pulse kind");
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
		throw new TypeError("timeoutMs must be positive");
	const explicit = options.sessionId;
	if (
		explicit !== undefined &&
		(!Number.isSafeInteger(explicit) || explicit < 65536)
	)
		throw new TypeError("sessionId must be a safe integer >= 65536");
	const pool =
		explicit === undefined ? actorPoolOf(options.connectors) : undefined;
	void leaseActor(options.scope, pool); // Ready for the scope's later pulses.
	const leased = leasedActor(options.scope, pool);
	const model = new CoreModel(
		// With a lease, the actor is chosen at the first local write.
		explicit ?? (leased === undefined ? randomActor() : 0),
		id,
		kind,
		definition.migrations.length + 1,
		definition.compiledSchema,
		definition.schemas,
		definition.migrationChain,
	);
	const log = new PatchLog(id);
	// A restore names a version: the root it builds is the document at that
	// version, replayed from the journal. Rows being appended are validated
	// before the journal has them, so they are counted in while they are.
	// ponytail: one stored value per restored version, kept for the life of
	// the pulse, since the versions below it replay through the same ones;
	// evict the oldest if documents come to be restored hundreds of times.
	let staged: readonly PulsePatchRow[] = [];
	const sources = new Map<string, RestoreSource | undefined>();
	// What was computed since rows were last committed: should they be
	// refused, by the model or by the journal, they may come back different.
	let fresh: string[] = [];
	const refused = () => {
		for (const key of fresh.splice(0)) sources.delete(key);
	};
	const staging = <T>(rows: readonly PulsePatchRow[], work: () => T): T => {
		staged = rows;
		try {
			return work();
		} finally {
			staged = [];
		}
	};
	model.restoreSource = (version) => {
		const key = JSON.stringify(version);
		if (!sources.has(key)) {
			fresh.push(key);
			const replay = new CoreModel(
				0,
				id,
				kind,
				definition.migrations.length + 1,
				definition.compiledSchema,
				definition.schemas,
				definition.migrationChain,
			);
			replay.restoreSource = model.restoreSource;
			// A row that waited in the journal is also among those just promoted.
			const rows = new Map<string, PulsePatchRow>();
			for (const row of [...log.missing([]), ...staged])
				rows.set(`${row.sid}:${row.clock}`, row);
			sources.set(key, replayTo([...rows.values()], version, replay));
		}
		return sources.get(key);
	};
	if (explicit === undefined && leased !== undefined)
		model.chooseActor = () => {
			// The leased actor may have written this document from an earlier
			// page, and its sequence must continue without a fork. That takes
			// every row it wrote here: none for a document created under a fresh
			// ID, and otherwise whatever each connector holds, so each of them
			// must have answered a complete download, and none may claim a clock
			// of the actor that is not here. Anything less (a write while
			// offline, a caller-chosen ID) gets a one-off random actor.
			// ponytail: a frame still in flight from a page that just closed can
			// reach a store after this check; the write that collides with it is
			// refused with CONFLICT. Have servers drop the older session of an
			// actor if that ever shows up.
			// Nor under an actor that an endpoint holds for another account:
			// its writes would be read as that account's.
			const next = new Map(log.vector).get(leased) ?? 1;
			const reuse =
				!meta.connections.some((connection) =>
					connection.refused.has(leased),
				) &&
				(generated ||
					(meta.connections.length > 0 &&
						!log.pendingCount &&
						meta.connections.every(
							(connection) =>
								connection.downloaded &&
								(new Map(connection.clockVector).get(leased) ?? 0) <= next,
						)));
			if (!reuse) return randomActor();
			model.nextClock = next;
			return leased;
		};
	const notifyListeners = () => {
		const listeners = [...meta.listeners];
		for (const listener of listeners) {
			try {
				listener();
			} catch (error) {
				meta.report(asPulseError(error));
			}
		}
	};
	const notify = () => {
		if (
			meta.loaded &&
			meta.connections.length &&
			meta.status === "synced" &&
			meta.connections.some(
				(connection) => !vectorCovers(connection.clockVector, log.vector),
			)
		)
			meta.status = "ready";
		notifyListeners();
		const rowListeners = [...meta.rowListeners];
		for (const listener of rowListeners) {
			try {
				listener();
			} catch (error) {
				meta.report(asPulseError(error));
			}
		}
	};
	const markLoaded = () => {
		const wasLoaded = meta.loaded;
		meta.loaded = !!model.root;
		if (!wasLoaded && meta.loaded && options.scope.pulses.get(id) === pulse)
			notifyScope(options.scope, id);
	};
	const context: ProxyContext = {
		get meta() {
			return meta;
		},
		assertActive() {
			if (meta.destroyed)
				throw new PulseError("CLOSED", "Pulse has been destroyed");
		},
	};
	const decode = (row: PulsePatchRow) => {
		try {
			return rowToPatch(row, (schema) => model.decodeEncoding(schema));
		} catch (error) {
			warnMigrationDrift(meta, error, row);
			throw error;
		}
	};
	/** Gap rows only move the frontier: there is nothing in them to apply. */
	const alive = (rows: PulsePatchRow[]) =>
		rows.some(isGapRow) ? rows.filter((row) => !isGapRow(row)) : rows;
	const serialize = (
		docId: string,
		patch: CorePatch,
		dependencies: PulseVersionVector,
	) => patchToRow(docId, patch, dependencies, model.encoding);
	// Under a root that records times, every transaction has one: the
	// creation, text and array edits and migrations too, not only field
	// writes. The document at a date is then the transactions up to it.
	const timed = definition.compiledSchema?.root.timestamps === true;
	// The actor of a pulse that synchronizes is one its scope wrote with: a
	// connector may say so to its endpoint, on this page or a later one.
	let remembered = false;
	const remember = () => {
		if (remembered || !meta.connections.length) return;
		remembered = true;
		rememberActor(options.scope, model.sid);
	};
	model.commit = (ops, hint, wallTime) => {
		if (meta.deleted)
			throw new PulseError("NOT_FOUND", "Document was permanently deleted");
		context.assertActive();
		if (!ops.length) return;
		remember();
		if (timed) wallTime ??= Date.now();
		fresh = [];
		const time = model.lamport + 1;
		if (!Number.isSafeInteger(time))
			throw new PulseError("LIMIT_EXCEEDED", "Lamport clock exhausted");
		const patch = new CorePatch(
			model.sid,
			model.nextClock,
			time,
			model.schemaId,
			ops,
			wallTime,
		);
		const wasLoaded = meta.loaded;
		let applied: CorePatch[];
		if (!log.pendingCount) {
			log.appendLocalPatch(patch, serialize);
			model.apply(patch, hint);
			applied = [patch];
		} else {
			try {
				let patches: CorePatch[] = [patch];
				const ready = log.appendLocalPatch(patch, serialize, (all) => {
					const rows = alive(all);
					if (rows.length > 1) {
						patches = rows.map((row) =>
							row.sid === patch.sid && row.clock === patch.clock
								? patch
								: decode(row),
						);
						staging(all, () =>
							model.validate(
								patches,
								new Map(rows.map((row, i) => [patches[i]!, row.dependencies])),
							),
						);
					}
				});
				for (const item of patches)
					model.apply(item, item === patch ? hint : undefined);
				applied = patches;
				if (ready.length > 1) migrate();
			} catch (error) {
				refused();
				warnMigrationDrift(meta, error);
				throw error;
			}
		}
		for (const item of applied) bumpPatchRevisions(model, item);
		markLoaded();
		if (meta.subPulses) {
			let resync = !wasLoaded && meta.loaded;
			for (const item of applied) {
				invalidatePatchRefs(model, item);
				if (!resync && patchTouchesSub(model, item)) resync = true;
			}
			if (resync) meta.subPulses.sync(false);
		}
		if (meta.listeners.size || meta.rowListeners.size) notify();
	};
	model.commitScalar = (node, key, field, value, last) => {
		if (meta.deleted)
			throw new PulseError("NOT_FOUND", "Document was permanently deleted");
		context.assertActive();
		remember();
		if (log.pendingCount) {
			model.commit([
				{
					kind: 1,
					target: node.id,
					field,
					value: { value, constants: [], texts: [] },
					...(last ? { last: true as const } : {}),
				},
			]);
			return;
		}
		const time = model.lamport + 1;
		if (!Number.isSafeInteger(time))
			throw new PulseError("LIMIT_EXCEEDED", "Lamport clock exhausted");
		const sid = model.sid;
		const clock = model.nextClock;
		const patch = new ScalarPatch(
			sid,
			clock,
			time,
			model.schemaId,
			node.id,
			field,
			value,
			last,
		);
		log.appendLocalPatch(patch, serialize);
		model.lamport = time;
		model.nextClock = clock + 1;
		node.stamps.set(key, [time, sid, clock]);
		node.removeChild(key);
		if (node.layout?.counter)
			model.addToCounter(node, (value as number) - (node.data[key] ?? 0));
		node.data[key] = value;
		bumpNodeRevision(node);
		const wasLoaded = meta.loaded;
		markLoaded();
		if (meta.subPulses) {
			invalidateCachedRef(node, key, value);
			if ((!wasLoaded && meta.loaded) || containsSub(fieldLayoutOf(node, key)))
				meta.subPulses.sync(false);
		}
		if (meta.listeners.size || meta.rowListeners.size) notify();
	};
	let migrating = false;
	const migrate = (): boolean => {
		if (migrating || !meta.loaded || !definition.migrations.length)
			return false;
		const initialVersion = model.view().version as number;
		if (initialVersion > definition.migrations.length) return false;
		migrating = true;
		try {
			const initial = structuredClone(model.view()) as Record<string, unknown>;
			let before = initial;
			const changes = new Map<string, PreparedValue>();
			for (
				let version = initialVersion;
				version <= definition.migrations.length;
				version++
			) {
				const stored = structuredClone(before);
				// A stored map is a record of key strings; a migrator reads the Map.
				for (const field of definition.schemas?.[version - 1]?.root.fields ??
					[])
					if (containsMap(field.layout) && Object.hasOwn(stored, field.key))
						stored[field.key] = field.layout.snapshot(stored[field.key]);
				const update = definition.migrations[version - 1]!.migrator(stored);
				if (!update || typeof update !== "object" || Array.isArray(update))
					throw new TypeError("Migration must return an object");
				for (const key of ["id", "kind", "version", "generation"])
					if (Object.hasOwn(update, key))
						throw new TypeError(`${key} is managed by Pulsify`);
				const prepared = prepareValue(update);
				if (
					!prepared.value ||
					typeof prepared.value !== "object" ||
					Array.isArray(prepared.value)
				)
					throw new TypeError("Migration must return an object");
				const data = prepared.value as Record<string, unknown>;
				for (const [key, value] of Object.entries(data))
					changes.set(key, {
						value,
						constants: prepared.constants
							.filter((path) => path[0] === key)
							.map((path) => path.slice(1)),
						texts: prepared.texts
							.filter((path) => path[0] === key)
							.map((path) => path.slice(1)),
					});
				// Subsequent migrators see detached stored data, without view methods
				// or initialization markers from an earlier step.
				before = { ...before, ...data, version: version + 1 };
				changes.set("version", prepareValue(version + 1));
			}
			const latest = definition.compiledSchema;
			const source = definition.schemas?.[initialVersion - 1];
			const normalized = model.prepareRoot(prepareValue(before), latest)
				.value as Record<string, unknown>;
			const sameConstant = (left: unknown, right: unknown): boolean => {
				if (left === right) return true;
				if (
					left === null ||
					right === null ||
					typeof left !== "object" ||
					typeof right !== "object"
				)
					return false;
				if (left instanceof Uint8Array || right instanceof Uint8Array)
					return (
						left instanceof Uint8Array &&
						right instanceof Uint8Array &&
						left.length === right.length &&
						left.every((byte, index) => byte === right[index])
					);
				if (Array.isArray(left) !== Array.isArray(right)) return false;
				const keys = Object.keys(left);
				return (
					keys.length === Object.keys(right).length &&
					keys.every(
						(key) =>
							Object.hasOwn(right, key) &&
							sameConstant(
								(left as Record<string, unknown>)[key],
								(right as Record<string, unknown>)[key],
							),
					)
				);
			};
			if (source?.root.constant) {
				const application = (data: Record<string, unknown>) =>
					Object.fromEntries(
						Object.entries(data).filter(
							([key]) => !["id", "kind", "version", "generation"].includes(key),
						),
					);
				if (!sameConstant(application(initial), application(normalized)))
					throw new TypeError("Migration cannot change a constant document");
				if (latest && !latest.root.constant)
					throw new TypeError(
						"Migration cannot remove a root constant annotation",
					);
			}
			for (const [key, prepared] of changes) {
				if (key === "version") continue;
				const previous = source?.fieldAt([key], initial);
				const field = latest?.fieldAt([key], normalized);
				const previousLayout =
					previous?.layout ?? source?.layoutAt([key], initial);
				const fieldLayout =
					field?.layout ?? latest?.layoutAt([key], normalized);
				if (previous?.constant || previousLayout?.constant) {
					if (!sameConstant(initial[key], prepared.value))
						throw new TypeError(
							`Migration cannot change constant field ${key}`,
						);
					// An unchanged immutable register needs no replacement operation.
					changes.delete(key);
					continue;
				}
				if (latest && !fieldLayout)
					throw new TypeError(`Unknown migration schema property ${key}`);
				changes.set(key, model.normalize(prepared, fieldLayout));
			}
			const annotations = (
				schema: typeof latest,
				data: Record<string, unknown>,
				key: string,
			) => {
				const constants: string[][] = [],
					texts: string[][] = [],
					counters: string[][] = [];
				const visit = (value: unknown, path: string[], relative: string[]) => {
					const layout = schema?.layoutAt(path, data);
					if (!layout) return;
					if (layout.constant) {
						constants.push(relative);
						return;
					}
					if (layout.richText) {
						if (typeof value === "string") texts.push(relative);
						return;
					}
					// A number that becomes a counter, or stops being one, is rebuilt.
					if (layout.counter) {
						if (typeof value === "number") counters.push(relative);
						return;
					}
					if (
						!value ||
						typeof value !== "object" ||
						value instanceof Uint8Array
					)
						return;
					for (const child of Object.keys(value))
						visit(
							(value as Record<string, unknown>)[child],
							[...path, child],
							[...relative, child],
						);
				};
				visit(data[key], [key], []);
				return { constants, texts, counters };
			};
			const signature = (paths: Record<string, string[][]>) =>
				JSON.stringify(
					["constants", "texts", "counters"].map((kind) =>
						paths[kind]!.map((path) => JSON.stringify(path)).sort(),
					),
				);
			const mergePaths = (
				left: string[][],
				right: string[][],
				removed: string[][],
			) => {
				const drop = new Set(removed.map((path) => JSON.stringify(path)));
				const result = new Map<string, string[]>();
				for (const path of left)
					if (!drop.has(JSON.stringify(path)))
						result.set(JSON.stringify(path), path);
				for (const path of right) result.set(JSON.stringify(path), path);
				return [...result.values()];
			};
			if (latest)
				for (const key of Object.keys(normalized)) {
					if (managedFields.has(key)) continue;
					const field = latest.fieldAt([key], normalized);
					const layout = field?.layout ?? latest.layoutAt([key], normalized);
					if (!layout) continue;
					const original = annotations(source, initial, key);
					for (const path of original.constants) {
						const replacement = latest.layoutAt([key, ...path], normalized);
						if (replacement && !replacement.constant)
							throw new TypeError(
								`Migration cannot make constant field ${[key, ...path].join(".")} mutable`,
							);
					}
					// A retired field is retained by existing storage; its absence from
					// the latest schema alone must not synthesize a mutable replacement.
					const previous = {
						constants: original.constants.filter((path) =>
							latest.layoutAt([key, ...path], normalized),
						),
						texts: original.texts.filter((path) =>
							latest.layoutAt([key, ...path], normalized),
						),
						counters: original.counters.filter((path) =>
							latest.layoutAt([key, ...path], normalized),
						),
					};
					const next = annotations(latest, normalized, key);
					if (signature(previous) === signature(next)) continue;
					const prepared = model.normalize(
						changes.get(key) ?? prepareValue(normalized[key]),
						layout,
					);
					// Replace the enclosing root field with an explicit snapshot capture.
					// This detaches old child IDs, so late v1 edits cannot change a newly
					// constant descendant. Paths are relative to the captured field and
					// include concrete array indices/map keys rather than schema wildcards.
					changes.set(key, {
						value: prepared.value,
						constants: mergePaths(
							prepared.constants,
							next.constants,
							previous.constants,
						),
						texts: mergePaths(prepared.texts, next.texts, previous.texts),
					});
				}
			const root = model.root!;
			const ops: CoreOperation[] = [...changes].map(([key, value]) => ({
				kind: 1,
				target: root.id,
				field: model.field(root, key),
				value,
			}));
			model.commit(ops);
			return true;
		} finally {
			migrating = false;
		}
	};
	let status: SynchronizationStatus = "idle";
	const meta: PulseMeta = {
		id,
		definition,
		model,
		log,
		options,
		pulse: undefined as unknown as Pulse<any>,
		// Every assignment goes through here, so status listeners see each change once.
		get status() {
			return status;
		},
		set status(next) {
			if (next === status) return;
			status = next;
			for (const listener of [...meta.statusListeners]) {
				try {
					listener(next);
				} catch (error) {
					meta.report(asPulseError(error));
				}
			}
		},
		statusListeners: new Set(),
		destroyed: false,
		loaded: false,
		lastError: undefined,
		connections: [],
		connecting: undefined,
		cancelConnection: undefined,
		listeners: new Set(),
		rowListeners: new Set(),
		presence: undefined,
		mutate: (ops) => model.commit(ops),
		migrate: () => migrate(),
		forgetRestore: (version) => void sources.delete(JSON.stringify(version)),
		disownActors(actors) {
			// An explicit actor is the application's choice, and stays.
			if (explicit !== undefined || !actors.includes(model.chosenActor)) return;
			model.retireActor();
			model.chooseActor ??= randomActor;
			remembered = false;
		},
		report(error) {
			meta.lastError = error;
			try {
				options.onError(error);
			} catch {
				/* Bookkeeping cannot be interrupted by an error hook. */
			}
		},
		applyRows(rows) {
			if (meta.deleted)
				throw new PulseError("NOT_FOUND", "Document was permanently deleted");
			fresh = [];
			try {
				context.assertActive();
				const delta = stateDeltaOf(rows);
				if (delta) {
					if (delta.schema !== model.schemaId) model.schemaFor(delta.schema);
					if (
						delta.clock + delta.count <=
						(new Map(log.vector).get(delta.sid) ?? 1)
					) {
						log.acceptState(delta, () => {});
						return;
					}
					let value: CoreScalar;
					try {
						value = model.encoding.decode(
							delta.layout,
							delta.data,
						) as CoreScalar;
					} catch (cause) {
						if (cause instanceof PulseError) throw cause;
						throw new PulseError("INVALID_MESSAGE", "Invalid state value", {
							cause,
						});
					}
					model.validateScalarRun(delta, [value]);
					const patch = new ScalarPatch(
						delta.sid,
						delta.clock + delta.count - 1,
						delta.lamport + delta.count - 1,
						delta.schema,
						delta.target,
						delta.field,
						value,
					);
					let pending: CorePatch[] = [];
					const result = log.acceptState(delta, (all) => {
						const ready = alive(all);
						pending = ready.map(decode);
						if (pending.length)
							staging(all, () =>
								model.validate(
									pending,
									new Map(
										ready.map((row, i) => [pending[i]!, row.dependencies]),
									),
								),
							);
					});
					if (result.changed) {
						const wasLoaded = meta.loaded;
						model.apply(patch);
						bumpPatchRevisions(model, patch);
						for (const item of pending) {
							model.apply(item);
							bumpPatchRevisions(model, item);
						}
						markLoaded();
						const migrated = migrate();
						if (meta.subPulses) {
							invalidatePatchRefs(model, patch);
							let resync =
								(!wasLoaded && meta.loaded) ||
								migrated ||
								patchTouchesSub(model, patch);
							for (const item of pending) {
								invalidatePatchRefs(model, item);
								if (!resync && patchTouchesSub(model, item)) resync = true;
							}
							if (resync) meta.subPulses.sync(true);
						}
						notify();
					}
					return;
				}

				const run = scalarRunOf(rows);
				const column = run && model.scalarColumn(run.target, run.field);
				if (
					run &&
					column &&
					run.schema === model.schemaId &&
					run.layout === column.id + 2
				) {
					let values: ReturnType<typeof readRunValues> | undefined;
					if (
						log.appendContiguousRun(rows, () => {
							values = readRunValues(run, column.kind);
							model.validateScalarRun(run, values);
						})
					) {
						const wasLoaded = meta.loaded;
						const patch = new ScalarPatch(
							run.sid,
							run.clock + run.count - 1,
							run.lamport + run.count - 1,
							run.schema,
							run.target,
							run.field,
							values![run.count - 1]!,
						);
						model.apply(patch);
						bumpPatchRevisions(model, patch);
						markLoaded();
						if (meta.subPulses) {
							invalidatePatchRefs(model, patch);
							if ((!wasLoaded && meta.loaded) || patchTouchesSub(model, patch))
								meta.subPulses.sync(true);
						}
						notify();
						return;
					}
					// A retransmitted lone write is already applied.
					const held = log.find(run.sid, run.clock);
					if (held && sameScalarWrite(held, run, meta)) return;
				}

				if (rows.length === 1 && !log.pendingCount) {
					const patch = decode(rows[0]!);
					// A known row comes back as a gap when its span covers more.
					const ready = log.appendRemoteRows(rows, (available) => {
						if (alive(available).length)
							staging(available, () =>
								model.validateSingle(patch, available[0]!.dependencies),
							);
					});
					if (alive(ready).length) {
						const wasLoaded = meta.loaded;
						model.apply(patch);
						bumpPatchRevisions(model, patch);
						markLoaded();
						const migrated = migrate();
						if (meta.subPulses) {
							invalidatePatchRefs(model, patch);
							if (
								(!wasLoaded && meta.loaded) ||
								migrated ||
								patchTouchesSub(model, patch)
							)
								meta.subPulses.sync(true);
						}
						notify();
					}
					return;
				}
				const decoded = new Map(
					rows.map((row) => [`${row.sid}:${row.clock}`, decode(row)]),
				);
				let patches: CorePatch[] = [];
				const ready = log.appendRemoteRows(rows, (all) => {
					const available = alive(all);
					patches = available.map(
						(row) => decoded.get(`${row.sid}:${row.clock}`) ?? decode(row),
					);
					staging(all, () =>
						model.validate(
							patches,
							new Map(
								available.map((row, i) => [patches[i]!, row.dependencies]),
							),
						),
					);
				});
				const wasLoaded = meta.loaded;
				for (const patch of patches) {
					model.apply(patch);
					bumpPatchRevisions(model, patch);
				}
				if (ready.length) {
					markLoaded();
					const migrated = migrate();
					if (meta.subPulses) {
						let resync = (!wasLoaded && meta.loaded) || migrated;
						for (const patch of patches) {
							invalidatePatchRefs(model, patch);
							if (!resync && patchTouchesSub(model, patch)) resync = true;
						}
						if (resync) meta.subPulses.sync(true);
					}
					notify();
				}
			} catch (error) {
				refused();
				warnMigrationDrift(meta, error);
				throw error;
			}
		},
	};
	let pulse = createObjectProxy(() => model.root, context, true) as Pulse<any>;
	if (definition.materializer) {
		const bindings = definition.materializer({
			bind: (key: PropertyKey): Binding<any, any> => ({
				sourceKey: key,
				get: (data) => data[key],
				set: (data, value) => {
					data[key] = value;
				},
			}),
		});
		for (const key of ["id", "kind", "version", "generation"])
			if (Object.hasOwn(bindings, key))
				throw new TypeError(`${key} cannot be materialized`);
		pulse = bindPulse(pulse, bindings);
	}
	meta.pulse = pulse;
	meta.connections = options.connectors.map(
		(connector) => new Connection(pulse, connector),
	);
	if (hasSubLayout(definition.compiledSchema))
		meta.subPulses = createSubPulseTracker(meta, notifyListeners);
	if (data) {
		model.validateRoot(data, model.schemaId);
		const prepared = model.prepareRootInput(data);
		model.commit([{ kind: 0, value: prepared }]);
		meta.subPulses?.enable();
	}
	options.scope.pulses.set(id, pulse);
	if (meta.loaded) notifyScope(options.scope, id);
	return pulse;
}
