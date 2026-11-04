import type { PulseMeta } from "./PulseMeta.js";
export type ProxyContext = {
	meta: PulseMeta;
	assertActive(): void;
};
