import * as Y from "yjs";
import { array, object } from "@gin-quin/codec";
import { LoroDoc, LoroList, LoroMap, type VersionVector } from "loro-crdt";
import { Model, s } from "json-joy/lib/json-crdt/index.js";
import { Delta } from "json-joy/lib/json-crdt/delta/Delta.js";
import type { IClockVector } from "json-joy/lib/json-crdt-patch/clock/index.js";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	exportPulseUpdates,
	applyPulseUpdates,
	SUPPORTED_PROTOCOL_VERSIONS,
	type Pulse,
	type PulseProperties,
} from "../packages/pulse/source/index.js";
import { createRuntime } from "../packages/pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../packages/pulse/source/pulses/PulseOptions.js";
import type { PulseVersionVector } from "../packages/pulse/source/connection/PulseVersionVector.js";
import { toNodeBuilder } from "./json-joy-builder.js";
import type { CoreNode } from "../packages/pulse/source/core/model.js";

export type Engine = "pulsify" | "json-joy" | "yjs" | "loro";
export type Item = { value: number; label: string };
export type Data = PulseProperties<"Comparison"> & {
	title: string;
	nested: { count: number };
	items: Item[];
};
// Compile once outside sample timing, as the legacy Definition was. The data
// shape and editable containers are unchanged; only Pulsify's schema knowledge
// is now supplied explicitly, as required by its native engine API.
const Definition = definePulse(
	"Comparison",
	object({
		title: "string",
		nested: object({ count: "float64" }),
		items: array(object({ value: "float64", label: "string" })),
	}),
).materialize();
export const fixture = (size: number): Data => ({
	id: "comparison",
	kind: "Comparison",
	version: 1,
	generation: 0,
	title: "Performance é🌍",
	nested: { count: 0 },
	items: Array.from({ length: size }, (_, value) => ({
		value,
		label: `item-${value}`,
	})),
});
export type Checkpoint = { engine: Engine; value: unknown; dispose(): void };
export type Packet = { frames: Uint8Array[]; bytes: number };
const packet = (frames: Uint8Array[]): Packet => ({
	frames,
	bytes: frames.reduce((sum, frame) => sum + frame.length, 0),
});
const checkpoint = (
	engine: Engine,
	value: unknown,
	dispose = () => {},
): Checkpoint => ({ engine, value, dispose });
function from<T>(engine: Engine, version: Checkpoint): T {
	if (version.engine !== engine) throw new Error("Cross-engine version vector");
	return version.value as T;
}
export interface Replica {
	readonly engine: Engine;
	readCount(): number;
	setCount(value: number): void;
	setTitle(value: string): void;
	append(item: Item): void;
	removeFirst(): void;
	snapshot(): Data;
	checkpoint(): Checkpoint;
	exportSince(version: Checkpoint): Packet;
	exportFull(): Packet;
	importDelta(bytes: Packet): void;
	importFull(bytes: Packet): void;
	dispose(): void;
}

export function createReplica(
	engine: Engine,
	data?: Data,
	actor = 65536,
	directPulse = false,
	yjsV1 = false,
): Replica {
	switch (engine) {
		case "pulsify":
			return pulseReplica(data, actor, directPulse);
		case "json-joy":
			return nativeReplica(data, actor);
		case "yjs":
			return yReplica(data, actor, yjsV1);
		case "loro":
			return loroReplica(data, actor);
	}
}
function pulseReplica(
	data: Data | undefined,
	actor: number,
	direct: boolean,
): Replica {
	const options = {
		...defaultPulseOptions,
		scope: createPulseScope(),
		sessionId: actor,
	};
	const pulse: Pulse<Data> = data
		? createPulse(
				Definition,
				{
					id: data.id,
					title: data.title,
					nested: data.nested,
					items: data.items,
				},
				options,
			)
		: (createRuntime(Definition, "comparison", options) as Pulse<Data>);
	const meta = getPulseMeta(pulse);
	// These caches are resolved outside timed loops by the benchmark runner.
	let nested: Pulse<Data>["nested"] | undefined;
	let nativeNested: CoreNode | undefined;
	const liveNested = () => (nested ??= pulse.nested);
	const rawNested = () =>
		(nativeNested ??= meta.model.root!.children.get("nested")!);
	const encode = (vv: PulseVersionVector) =>
		packet(
			exportPulseUpdates(pulse, vv, {
				peerVersion: SUPPORTED_PROTOCOL_VERSIONS[2],
			}),
		);
	const apply = (bytes: Packet) => applyPulseUpdates(pulse, bytes.frames);
	return {
		engine: "pulsify",
		readCount() {
			return direct ? Number(rawNested().data.count) : liveNested().count;
		},
		setCount(value) {
			if (direct) meta.model.set(rawNested(), "count", value);
			else liveNested().count = value;
		},
		setTitle(value) {
			pulse.title = value;
		},
		append(value) {
			pulse.items.push(value);
		},
		removeFirst() {
			pulse.items.splice(0, 1);
		},
		snapshot() {
			return snapshotPulse(pulse) as Data;
		},
		checkpoint() {
			return checkpoint("pulsify", meta.log.vector);
		},
		exportSince(version) {
			return encode(from<PulseVersionVector>("pulsify", version));
		},
		exportFull() {
			return encode([]);
		},
		importDelta: apply,
		importFull: apply,
		dispose() {
			destroyPulse(pulse);
		},
	};
}
function nativeReplica(data: Data | undefined, actor: number): Replica {
	let model: Model = data
		? Model.create(toNodeBuilder(data), actor)
		: Model.create(undefined, actor);
	model.api.flush();
	let nested: ReturnType<typeof model.api.obj> | undefined;
	const getNested = () => (nested ??= model.api.obj(["nested"]));
	const flush = () => {
		model.api.flush();
	};
	return {
		engine: "json-joy",
		readCount() {
			return Number((getNested().view() as Record<string, unknown>)["count"]);
		},
		setCount(value) {
			getNested().set({ count: s.con(value) });
			flush();
		},
		setTitle(value) {
			model.api.obj().set({ title: toNodeBuilder(value) });
			flush();
		},
		append(value) {
			model.api.arr(["items"]).push(toNodeBuilder(value));
			flush();
		},
		removeFirst() {
			const list = model.api.arr(["items"]);
			if (list.length()) list.del(0, 1);
			flush();
		},
		snapshot() {
			return structuredClone(model.view()) as Data;
		},
		checkpoint() {
			return checkpoint("json-joy", model.clock.clone());
		},
		exportSince(version) {
			return packet([
				model.delta(from<IClockVector>("json-joy", version)).toBinary(),
			]);
		},
		exportFull() {
			return packet([model.toBinary()]);
		},
		importDelta(bytes) {
			for (const frame of bytes.frames) model.applyDelta(Delta.from(frame));
		},
		importFull(bytes) {
			if (bytes.frames.length !== 1) throw new Error("Expected one snapshot");
			model = Model.load(bytes.frames[0]!, actor);
			nested = undefined;
		},
		dispose() {},
	};
}
function yReplica(data: Data | undefined, actor: number, v1: boolean): Replica {
	const doc = new Y.Doc();
	const encode = v1 ? Y.encodeStateAsUpdate : Y.encodeStateAsUpdateV2;
	const apply = v1 ? Y.applyUpdate : Y.applyUpdateV2;
	// Deterministic, distinct actors within isolated benchmark documents only.
	doc.clientID = actor;
	const root = doc.getMap<unknown>("root");
	if (data)
		doc.transact(() => {
			for (const [key, value] of Object.entries(data))
				if (key !== "nested" && key !== "items") root.set(key, value);
			const nested = new Y.Map<number>();
			nested.set("count", data.nested.count);
			root.set("nested", nested);
			const items = new Y.Array<Y.Map<unknown>>();
			items.insert(
				0,
				data.items.map((item) => new Y.Map<unknown>(Object.entries(item))),
			);
			root.set("items", items);
		});
	let nested: Y.Map<number> | undefined;
	const getNested = () => (nested ??= root.get("nested") as Y.Map<number>);
	const list = () => root.get("items") as Y.Array<Y.Map<unknown>>;
	return {
		engine: "yjs",
		readCount() {
			return getNested().get("count")!;
		},
		setCount(value) {
			getNested().set("count", value);
		},
		setTitle(value) {
			root.set("title", value);
		},
		append(value) {
			list().push([new Y.Map<unknown>(Object.entries(value))]);
		},
		removeFirst() {
			if (list().length) list().delete(0, 1);
		},
		snapshot() {
			return root.toJSON() as Data;
		},
		checkpoint() {
			return checkpoint("yjs", Y.encodeStateVector(doc));
		},
		exportSince(version) {
			return packet([encode(doc, from<Uint8Array>("yjs", version))]);
		},
		exportFull() {
			return packet([encode(doc)]);
		},
		importDelta(bytes) {
			for (const frame of bytes.frames) apply(doc, frame);
		},
		importFull(bytes) {
			for (const frame of bytes.frames) apply(doc, frame);
			nested = undefined;
		},
		dispose() {
			doc.destroy();
		},
	};
}
function loroReplica(data: Data | undefined, actor: number): Replica {
	const doc = new LoroDoc();
	doc.setPeerId(actor);
	const root = doc.getMap("root");
	let nested: LoroMap | undefined;
	let items: LoroList | undefined;
	if (data) {
		for (const [key, value] of Object.entries(data))
			if (key !== "nested" && key !== "items") root.set(key, value);
		const detachedMap = new LoroMap();
		nested = root.setContainer("nested", detachedMap);
		detachedMap.free();
		nested.set("count", data.nested.count);
		const detachedList = new LoroList();
		items = root.setContainer("items", detachedList);
		detachedList.free();
		for (const item of data.items) append(item);
		doc.commit();
	}
	function getNested(): LoroMap {
		return (nested ??= root.get("nested") as LoroMap);
	}
	function getItems(): LoroList {
		return (items ??= root.get("items") as LoroList);
	}
	function append(value: Item): void {
		const detached = new LoroMap();
		const item = getItems().pushContainer(detached);
		detached.free();
		item.set("value", value.value);
		item.set("label", value.label);
		item.free();
	}
	return {
		engine: "loro",
		readCount() {
			return Number(getNested().get("count"));
		},
		setCount(value) {
			getNested().set("count", value);
			doc.commit();
		},
		setTitle(value) {
			root.set("title", value);
			doc.commit();
		},
		append(value) {
			append(value);
			doc.commit();
		},
		removeFirst() {
			const list = getItems();
			if (list.length) list.delete(0, 1);
			doc.commit();
		},
		snapshot() {
			return root.toJSON() as Data;
		},
		checkpoint() {
			const vv = doc.oplogVersion();
			return checkpoint("loro", vv, () => vv.free());
		},
		exportSince(version) {
			return packet([
				doc.export({
					mode: "update",
					from: from<VersionVector>("loro", version),
				}),
			]);
		},
		exportFull() {
			return packet([doc.export({ mode: "snapshot" })]);
		},
		importDelta(bytes) {
			for (const frame of bytes.frames) doc.import(frame);
		},
		importFull(bytes) {
			for (const frame of bytes.frames) doc.import(frame);
		},
		dispose() {
			nested?.free();
			items?.free();
			root.free();
			doc.free();
		},
	};
}
