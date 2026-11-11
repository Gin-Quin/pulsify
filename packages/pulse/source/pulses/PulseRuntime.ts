import type { SynchronizationStatus } from "../connection/SynchronizationStatus.js";
import { stateDeltaOf } from "../protocol/stateDeltas.js";
import { scalarRunOf, readRunValues } from "../protocol/scalarRuns.js";
import { Connection } from "../connection/Connection.js";
import {
	patchToRow,
	rowToPatch,
	type PulsePatchRow,
} from "../connection/PulsePatch.js";
import type { PulseVersionVector } from "../connection/PulseVersionVector.js";
import { CoreModel, managedFields } from "../core/model.js";
import {
	CorePatch,
	ScalarPatch,
	type CoreOperation,
	type CoreScalar,
} from "../core/operations.js";
import { prepareValue, type PreparedValue } from "../core/values.js";
import { PulseError, asPulseError } from "../protocol/errors.js";
import { PatchLog } from "../protocol/PatchLog.js";
import { bind as bindPulse, type Binding } from "./Bindings.js";
import type { Pulse } from "./Pulse.js";
import type { AnyPulseDefinition } from "./PulseDefinition.js";
import type { PulseMeta } from "./PulseMeta.js";
import { createObjectProxy } from "./PulseObject.js";
import type { PulseOptions } from "./PulseOptions.js";
import type { ProxyContext } from "./ProxyContext.js";
import { warnMigrationDrift } from "./warnMigrationDrift.js";

export function createRuntime(
	definition: AnyPulseDefinition,
	id: string,
	options: PulseOptions,
	data?: Record<string, unknown>,
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
	const sid = options.sessionId ?? randomActor();
	if (!Number.isSafeInteger(sid) || sid < 65536)
		throw new TypeError("sessionId must be a safe integer >= 65536");
	const model = new CoreModel(
		sid,
		id,
		kind,
		definition.migrations.length + 1,
		definition.compiledSchema,
		definition.schemas,
		definition.migrationChain,
	);
	const log = new PatchLog(id);
	const notify = () => {
		if (meta.loaded && meta.connections.length && meta.status === "synced")
			meta.status = "ready";
		const listeners = [...meta.listeners],
			rowListeners = [...meta.rowListeners];
		for (const listener of listeners) {
			try {
				listener();
			} catch (error) {
				meta.report(asPulseError(error));
			}
		}
		for (const listener of rowListeners) {
			try {
				listener();
			} catch (error) {
				meta.report(asPulseError(error));
			}
		}
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
	const serialize = (
		docId: string,
		patch: CorePatch,
		dependencies: PulseVersionVector,
	) => patchToRow(docId, patch, dependencies, model.encoding);
	model.commit = (ops, hint) => {
		context.assertActive();
		if (!ops.length) return;
		const time = model.lamport + 1;
		if (!Number.isSafeInteger(time))
			throw new PulseError("LIMIT_EXCEEDED", "Lamport clock exhausted");
		const patch = new CorePatch(
			sid,
			model.nextClock,
			time,
			model.schemaId,
			ops,
		);
		if (!log.pendingCount) {
			log.appendLocalPatch(patch, serialize);
			model.apply(patch, hint);
		} else {
			try {
				let patches: CorePatch[] = [patch];
				const ready = log.appendLocalPatch(patch, serialize, (rows) => {
					if (rows.length > 1) {
						patches = rows.map((row) =>
							row.sid === sid && row.clock === patch.clock
								? patch
								: decode(row),
						);
						model.validate(
							patches,
							new Map(rows.map((row, i) => [patches[i]!, row.dependencies])),
						);
					}
				});
				for (const item of patches)
					model.apply(item, item === patch ? hint : undefined);
				if (ready.length > 1) migrate();
			} catch (error) {
				warnMigrationDrift(meta, error);
				throw error;
			}
		}
		meta.loaded = !!model.root;
		if (meta.listeners.size || meta.rowListeners.size) notify();
	};
	model.commitScalar = (node, key, field, value) => {
		context.assertActive();
		if (log.pendingCount) {
			model.commit([
				{
					kind: 1,
					target: node.id,
					field,
					value: { value, constants: [], texts: [] },
				},
			]);
			return;
		}
		const time = model.lamport + 1;
		if (!Number.isSafeInteger(time))
			throw new PulseError("LIMIT_EXCEEDED", "Lamport clock exhausted");
		const clock = model.nextClock;
		const patch = new ScalarPatch(
			sid,
			clock,
			time,
			model.schemaId,
			node.id,
			field,
			value,
		);
		log.appendLocalPatch(patch, serialize);
		model.lamport = time;
		model.nextClock = clock + 1;
		node.stamps.set(key, [time, sid, clock]);
		node.removeChild(key);
		node.data[key] = value;
		meta.loaded = !!model.root;
		if (meta.listeners.size || meta.rowListeners.size) notify();
	};
	let migrating = false;
	const migrate = () => {
		if (migrating || !meta.loaded || !definition.migrations.length) return;
		const initialVersion = model.view().version as number;
		if (initialVersion > definition.migrations.length) return;
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
				const update = definition.migrations[version - 1]!.migrator(
					structuredClone(before),
				);
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
					texts: string[][] = [];
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
				return { constants, texts };
			};
			const signature = (paths: { constants: string[][]; texts: string[][] }) =>
				JSON.stringify([
					paths.constants.map((path) => JSON.stringify(path)).sort(),
					paths.texts.map((path) => JSON.stringify(path)).sort(),
				]);
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
		mutate: (ops) => model.commit(ops),
		report(error) {
			meta.lastError = error;
			try {
				options.onError(error);
			} catch {
				/* Bookkeeping cannot be interrupted by an error hook. */
			}
		},
		applyRows(rows) {
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
					const result = log.acceptState(delta, (ready) => {
						pending = ready.map(decode);
						if (pending.length)
							model.validate(
								pending,
								new Map(ready.map((row, i) => [pending[i]!, row.dependencies])),
							);
					});
					if (result.changed) {
						model.apply(patch);
						for (const item of pending) model.apply(item);
						meta.loaded = !!model.root;
						migrate();
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
						model.apply(
							new ScalarPatch(
								run.sid,
								run.clock + run.count - 1,
								run.lamport + run.count - 1,
								run.schema,
								run.target,
								run.field,
								values![run.count - 1]!,
							),
						);
						meta.loaded = !!model.root;
						notify();
						return;
					}
				}

				if (rows.length === 1 && !log.pendingCount) {
					const patch = decode(rows[0]!);
					const ready = log.appendRemoteRows(rows, (available) => {
						if (available.length)
							model.validateSingle(patch, available[0]!.dependencies);
					});
					if (ready.length) {
						model.apply(patch);
						meta.loaded = !!model.root;
						migrate();
						notify();
					}
					return;
				}
				const decoded = new Map(
					rows.map((row) => [`${row.sid}:${row.clock}`, decode(row)]),
				);
				let patches: CorePatch[] = [];
				const ready = log.appendRemoteRows(rows, (available) => {
					patches = available.map(
						(row) => decoded.get(`${row.sid}:${row.clock}`) ?? decode(row),
					);
					model.validate(
						patches,
						new Map(available.map((row, i) => [patches[i]!, row.dependencies])),
					);
				});
				for (const patch of patches) model.apply(patch);
				if (ready.length) {
					meta.loaded = !!model.root;
					migrate();
					notify();
				}
			} catch (error) {
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
	if (data) {
		model.validateRoot(data, model.schemaId);
		const prepared = model.prepareRootInput(data);
		model.commit([{ kind: 0, value: prepared }]);
	}
	options.scope.pulses.set(id, pulse);
	return pulse;
}
function randomActor(): number {
	const bytes = crypto.getRandomValues(new Uint32Array(2));
	return 65536 + bytes[0]! * 1048576 + (bytes[1]! & 0xfffff);
}
