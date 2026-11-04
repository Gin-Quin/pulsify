import {
	Model,
	ConNode,
	ObjNode,
	NewConOp,
	NewObjOp,
	InsObjOp,
	InsValOp,
	InsArrOp,
	InsVecOp,
	UpdArrOp,
	compare,
	type Patch,
	type ITimestampStruct,
} from "json-joy/lib/json-crdt/index.js";
import { PatchBuilder } from "json-joy/lib/json-crdt-patch/PatchBuilder.js";
import { Connection } from "../connection/Connection.js";
import {
	patchToRow,
	rowToPatch,
	type PulsePatchRow,
} from "../connection/PulsePatch.js";
import { PulseError, asPulseError } from "../protocol/errors.js";
import { PatchLog } from "../protocol/PatchLog.js";
import { toNodeBuilder } from "../utilities/toNodeBuilder.js";
import { bind as bindPulse, type Binding } from "./Bindings.js";
import type { Pulse } from "./Pulse.js";
import type { AnyPulseDefinition } from "./PulseDefinition.js";
import type { PulseMeta } from "./PulseMeta.js";
import { assertProperty, createObjectProxy } from "./PulseObject.js";
import type { PulseOptions } from "./PulseOptions.js";
import type { ProxyContext } from "./ProxyContext.js";

export function createRuntime(
	definition: AnyPulseDefinition,
	id: string,
	options: PulseOptions,
	data?: Record<string, unknown>,
): Pulse<any> {
	if (!id.length || id.length > 1024 || !id.isWellFormed())
		throw new TypeError("Invalid pulse ID");
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
		throw new TypeError("timeoutMs must be positive");
	if (
		options.sessionId !== undefined &&
		(!Number.isSafeInteger(options.sessionId) || options.sessionId < 65536)
	)
		throw new TypeError("sessionId must be a safe integer >= 65536");
	const model = Model.create(undefined, options.sessionId);
	const log = new PatchLog(id);
	const notify = () => {
		if (meta.loaded && meta.connections.length && meta.status === "synced")
			meta.status = "ready";
		for (const listener of [...meta.listeners, ...meta.rowListeners]) {
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
		cache: new WeakMap(),
		assertActive() {
			if (meta.destroyed)
				throw new PulseError("CLOSED", "Pulse has been destroyed");
		},
		mutate(callback) {
			context.assertActive();
			// Keep the native patch; the journal encodes it only at the wire boundary.
			const builder = new PatchBuilder(model.clock.clone());
			const result = callback(builder);
			const patch = builder.flush();
			if (!patch.ops.length) return result;
			const patchId = patch.getId()!;
			const native = (row: PulsePatchRow) =>
				row.sid === patchId.sid && row.clock === patchId.time
					? patch
					: rowToPatch(row);
			const ready = log.appendPatch(patch, patchToRow, (available) => {
				if (available.length > 1) validateRootChanges(available.map(native));
			});
			for (const row of ready) model.applyPatch(native(row));
			meta.loaded = true;
			if (ready.length > 1) migrate();
			notify();
			return result;
		},
	};
	const validateMetadata = (value: unknown) => {
		if (value === undefined) return;
		const doc = value as Record<string, unknown>;
		if (
			!doc ||
			typeof doc !== "object" ||
			Array.isArray(doc) ||
			doc["id"] !== id ||
			doc["kind"] !== definition.kind ||
			!Number.isSafeInteger(doc["version"]) ||
			(doc["version"] as number) < 1 ||
			(doc["version"] as number) > definition.migrations.length + 1
		)
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"Document identity, kind or migration version is incompatible",
			);
		if (doc["generation"] !== undefined && doc["generation"] !== 0)
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"Restored document generations are not supported by protocol v1",
			);
	};
	// Only the root's four metadata fields need a compatibility check.
	const validateRootChanges = (patches: Patch[]) => {
		const ops = patches.flatMap((patch) => patch.ops);
		let rootId = model.root.val;
		for (const op of ops)
			if (
				op instanceof InsValOp &&
				op.obj.sid === 0 &&
				op.obj.time === 0 &&
				compare(op.val, rootId) > 0
			)
				rootId = op.val;
		const writes = ops.filter(
			(op): op is InsObjOp =>
				op instanceof InsObjOp && compare(op.obj, rootId) === 0,
		);
		const fields = ["id", "kind", "version", "generation"];
		const changed =
			rootId !== model.root.val ||
			writes.some((op) => op.data.some(([field]) => fields.includes(field)));
		const stored = model.index.get(rootId);
		if (
			changed &&
			!(stored instanceof ObjNode) &&
			!ops.some((op) => op instanceof NewObjOp && compare(op.id, rootId) === 0)
		)
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"Document root must be an object",
			);
		// json-joy owns nodes through one parent: sharing root metadata could let
		// garbage collection of an ordinary field delete the document identity.
		const owners = new Map<
			string,
			{ parent: ITimestampStruct; field?: string }
		>();
		const nodeKey = (ref: ITimestampStruct) => `${ref.sid}:${ref.time}`;
		const own = (
			ref: ITimestampStruct,
			parent: ITimestampStruct,
			field?: string,
		) => {
			if (ref.sid === 0) return;
			const previous = owners.get(nodeKey(ref));
			if (
				previous &&
				(compare(previous.parent, parent) !== 0 || previous.field !== field)
			)
				throw new PulseError(
					"INCOMPATIBLE_DOCUMENT",
					"Document metadata cannot share CRDT nodes",
				);
			owners.set(nodeKey(ref), {
				parent,
				...(field === undefined ? {} : { field }),
			});
		};
		own(model.root.val, model.root.id);
		own(rootId, model.root.id);
		const current = model.root.child();
		if (current instanceof ObjNode)
			for (const field of fields) {
				const ref = current.keys.get(field);
				if (ref) own(ref, current.id, field);
			}
		const metadata: Record<string, unknown> = {};
		if (changed)
			for (const field of fields) {
				let ref =
					stored instanceof ObjNode ? stored.keys.get(field) : undefined;
				for (const op of writes)
					for (const [name, value] of op.data)
						if (
							name === field &&
							value.time > rootId.time &&
							(!ref || compare(value, ref) > 0)
						)
							ref = value;
				const node =
					ref &&
					(ops.find(
						(op) => op instanceof NewConOp && compare(op.id, ref!) === 0,
					) ??
						model.index.get(ref));
				metadata[field] =
					node instanceof NewConOp || node instanceof ConNode
						? node.val
						: undefined;
				const previous =
					stored instanceof ObjNode ? stored.keys.get(field) : undefined;
				if (
					ref &&
					!(node instanceof NewConOp) &&
					(!previous || compare(ref, previous) !== 0)
				)
					throw new PulseError(
						"INCOMPATIBLE_DOCUMENT",
						"Document metadata cannot share existing CRDT nodes",
					);
				if (ref) own(ref, rootId, field);
			}
		const link = (
			parent: ITimestampStruct,
			ref: ITimestampStruct,
			field?: string,
		) => {
			const owner = owners.get(nodeKey(ref));
			if (
				owner &&
				(compare(owner.parent, parent) !== 0 || owner.field !== field)
			)
				throw new PulseError(
					"INCOMPATIBLE_DOCUMENT",
					"Document metadata cannot share CRDT nodes",
				);
		};
		for (const op of ops) {
			if (op instanceof InsObjOp || op instanceof InsVecOp)
				for (const [field, ref] of op.data) link(op.obj, ref, String(field));
			else if (op instanceof InsValOp || op instanceof UpdArrOp)
				link(op.obj, op.val);
			else if (op instanceof InsArrOp)
				for (const ref of op.data) link(op.obj, ref);
		}
		if (changed) validateMetadata(metadata);
	};
	const migrate = () => {
		if (!meta.loaded || !definition.migrations.length) return;
		const initialVersion = model.api.obj().get("version").view() as number;
		if (initialVersion > definition.migrations.length) return;
		let before = model.view() as Record<string, unknown>;
		const changes: Record<string, unknown> = {};
		for (
			let version = initialVersion;
			version <= definition.migrations.length;
			version++
		) {
			const migration = definition.migrations[version - 1]!;
			const update = migration.migrator(structuredClone(before) as any);
			if (!update || typeof update !== "object" || Array.isArray(update))
				throw new TypeError("Migration must return an object");
			for (const key of ["id", "kind", "version", "generation"])
				if (Object.hasOwn(update, key))
					throw new TypeError(`${key} is managed by Pulsify`);
			before = { ...before, ...update, version: version + 1 };
			Object.assign(changes, update, { version: version + 1 });
		}
		const values = Object.entries(changes).map(([key, value]) => {
			assertProperty(key);
			return [key, toNodeBuilder(value)] as const;
		});
		context.mutate((builder) =>
			builder.insObj(
				model.api.obj().node.id,
				values.map(([key, value]) => [key, builder.json(value)]),
			),
		);
	};
	const meta: PulseMeta = {
		id,
		definition,
		model,
		log,
		options,
		pulse: undefined as unknown as Pulse<any>,
		status: "idle",
		destroyed: false,
		loaded: false,
		lastError: undefined,
		connections: [],
		connecting: undefined,
		cancelConnection: undefined,
		listeners: new Set(),
		rowListeners: new Set(),
		mutate: context.mutate,
		report(error) {
			meta.lastError = error;
			try {
				options.onError(error);
			} catch {
				/* Error hooks cannot interrupt protocol bookkeeping. */
			}
		},
		applyRows(rows: PulsePatchRow[]) {
			context.assertActive();
			const decoded = new Map(
				rows.map((row) => [`${row.sid}:${row.clock}`, rowToPatch(row)]),
			);
			let patches: Patch[] = [];
			const ready = log.append(rows, (available) => {
				patches = available.map(
					(row) => decoded.get(`${row.sid}:${row.clock}`) ?? rowToPatch(row),
				);
				validateRootChanges(patches);
			});
			for (const patch of patches) model.applyPatch(patch);
			if (ready.length) {
				meta.loaded = model.root.child() !== undefined;
				migrate();
				notify();
			}
		},
	};
	let pulse = createObjectProxy(
		() => model.api.obj(),
		context,
		true,
	) as Pulse<any>;
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
		validateMetadata(data);
		const schema = toNodeBuilder(data);
		context.mutate((builder) => builder.root(builder.json(schema)));
	}
	options.scope.pulses.set(id, pulse);
	return pulse;
}
