import type { PulseMeta } from "./PulseMeta.js";
import type { PatchBuilder } from "json-joy/lib/json-crdt-patch/PatchBuilder.js";

export type ProxyContext = {
	meta: PulseMeta;
	cache: WeakMap<object, unknown>;
	mutate<T>(callback: (builder: PatchBuilder) => T): T;
	assertActive(): void;
};
