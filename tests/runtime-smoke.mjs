import { connectPulse, createMemoryConnector, createPulse, createPulseScope, definePulse, destroyPulse, disconnectPulse, getPulseMeta, loadPulse, PulseRelay, snapshotPulse, PulseError as CoreError } from "../packages/pulse/dist/index.js";
import { encodeMessage, decodeMessage, PulseError as ProtocolError, PulseRelay as ProtocolRelay } from "../packages/pulse/dist/protocol.js";
function assert(condition, message) { if (!condition) throw new Error(message); }
export async function smoke() {
	assert(CoreError === ProtocolError && PulseRelay === ProtocolRelay, "Entry points duplicate shared classes");
	try { decodeMessage(new Uint8Array([255])); throw new Error("Invalid frame was accepted"); } catch (error) { assert(error instanceof CoreError, "Protocol errors must match the core PulseError class"); }
	const Doc = definePulse("Runtime").materialize();
	const relay = new PulseRelay(); const connector = createMemoryConnector(relay);
	const a = createPulse(Doc, { id: "runtime", nested: { value: 1 }, items: [1, 2] }, { scope: createPulseScope(), connectors: [connector] });
	await connectPulse(a).synced;
	const b = await loadPulse(Doc, a.id, { scope: createPulseScope(), connectors: [connector], waitFor: "all" });
	const nested = b.nested;
	a.nested.value = 7; a.items.push(3);
	await getPulseMeta(a).connections[0].syncBack();
	for (let i = 0; i < 100 && b.nested.value !== 7; i++) await new Promise(resolve => setTimeout(resolve, 1));
	assert(nested.value === 7, "Retained reference was not updated");
	assert(JSON.stringify(snapshotPulse(a)) === JSON.stringify(snapshotPulse(b)), "Replicas did not converge");
	disconnectPulse(a); disconnectPulse(b);
	a.items.push(4); b.items.unshift(0);
	await Promise.all([connectPulse(a).synced, connectPulse(b).synced]);
	assert(JSON.stringify(snapshotPulse(a)) === JSON.stringify(snapshotPulse(b)), "Offline edits did not converge");
	const message = { kind: 1, docId: "runtime/🌍", requestId: 1, vv: [[65536, Number.MAX_SAFE_INTEGER]] };
	assert(JSON.stringify(decodeMessage(encodeMessage(message))) === JSON.stringify(message), "Protocol round-trip failed");
	destroyPulse(a); destroyPulse(b); assert(relay.peerCount === 0, "Session leak");
	return { ok: true, runtime: typeof navigator !== "undefined" ? navigator.userAgent : globalThis.process?.version ?? "unknown" };
}
if (typeof window === "undefined") console.log(JSON.stringify(await smoke()));
