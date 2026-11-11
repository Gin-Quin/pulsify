import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	loadPulse,
	exportPulseUpdates,
	applyPulseUpdates,
	getPulseVersions,
	PulseRelay,
	snapshotPulse,
	richText,
	PulseError as CoreError,
} from "../packages/pulse/dist/index.js";
import {
	encodeMessage,
	decodeMessage,
	PulseError as ProtocolError,
	PulseRelay as ProtocolRelay,
} from "../packages/pulse/dist/protocol.js";
import { moveSmoke } from "./move-runtime-smoke.mjs";
function assert(condition, message) {
	if (!condition) throw new Error(message);
}
export async function smoke() {
	await moveSmoke();
	assert(
		CoreError === ProtocolError && PulseRelay === ProtocolRelay,
		"Entry points duplicate shared classes",
	);
	try {
		decodeMessage(new Uint8Array([255]));
		throw new Error("Invalid frame was accepted");
	} catch (error) {
		assert(
			error instanceof CoreError,
			"Protocol errors must match the core PulseError class",
		);
	}
	const Doc = definePulse("Runtime").materialize();
	const relay = new PulseRelay();
	const connector = createMemoryConnector(relay);
	const a = createPulse(
		Doc,
		{ id: "runtime", nested: { value: 1 }, items: [1, 2] },
		{ scope: createPulseScope(), connectors: [connector] },
	);
	await connectPulse(a).synced;
	const b = await loadPulse(Doc, a.id, {
		scope: createPulseScope(),
		connectors: [connector],
		waitFor: "all",
	});
	const nested = b.nested;
	a.nested.value = 7;
	a.items.push(3);
	await getPulseMeta(a).connections[0].syncBack();
	for (let i = 0; i < 100 && b.nested.value !== 7; i++)
		await new Promise((resolve) => setTimeout(resolve, 1));
	assert(nested.value === 7, "Retained reference was not updated");
	assert(
		JSON.stringify(snapshotPulse(a)) === JSON.stringify(snapshotPulse(b)),
		"Replicas did not converge",
	);
	disconnectPulse(a);
	disconnectPulse(b);
	a.items.push(4);
	b.items.unshift(0);
	await Promise.all([connectPulse(a).synced, connectPulse(b).synced]);
	assert(
		JSON.stringify(snapshotPulse(a)) === JSON.stringify(snapshotPulse(b)),
		"Offline edits did not converge",
	);
	const message = {
		kind: 1,
		docId: "runtime/🌍",
		requestId: 1,
		vv: [[65536, Number.MAX_SAFE_INTEGER]],
	};
	assert(
		JSON.stringify(decodeMessage(encodeMessage(message))) ===
			JSON.stringify(message),
		"Protocol round-trip failed",
	);
	destroyPulse(a);
	destroyPulse(b);
	assert(relay.peerCount === 0, "Session leak");
	// The public entry points must share the grouped decoder's ownership map.
	const Grouped = definePulse("RuntimeGrouped", {
		_type: "object",
		fields: { value: "float64" },
	}).materialize();
	const x = createPulse(
		Grouped,
		{ id: "runtime-grouped", value: 0 },
		{ scope: createPulseScope(), sessionId: 65536, connectors: [connector] },
	);
	let y;
	try {
		await connectPulse(x).synced;
		y = await loadPulse(Grouped, x.id, {
			scope: createPulseScope(),
			sessionId: 65537,
			connectors: [connector],
			waitFor: "all",
		});
		disconnectPulse(x);
		disconnectPulse(y);
		for (let i = 1; i <= 100; i++) x.value = i;
		const frames = exportPulseUpdates(x, getPulseMeta(y).log.vector, {
			peerVersion: 2,
		});
		assert(frames[0][0] === 2, "Grouped public export did not use v2");
		const decoded = decodeMessage(frames[0]);
		const model = getPulseMeta(y).model,
			original = model.apply;
		let applications = 0;
		model.apply = function (...args) {
			applications++;
			return original.apply(this, args);
		};
		getPulseMeta(y).applyRows(decoded.rows);
		assert(
			y.value === 100 && applications === 1,
			"Entry points do not share the guarded grouped path",
		);
		applyPulseUpdates(y, frames);
		assert(
			getPulseMeta(y).log.size === 101,
			"Grouped duplicate changed retained history",
		);
		const base = getPulseMeta(y).log.vector;
		for (let i = 101; i <= 200; i++) x.value = i;
		const state = exportPulseUpdates(x, base, { peerVersion: 3 });
		assert(state[0][0] === 3, "State export did not negotiate v3");
		getPulseMeta(y).applyRows(decodeMessage(state[0]).rows);
		assert(y.value === 200, "State marker is not shared across entry points");
		assert(
			JSON.stringify(getPulseVersions(y).state) !==
				JSON.stringify(getPulseVersions(y).history),
			"State claimed omitted exact history",
		);
		applyPulseUpdates(
			y,
			exportPulseUpdates(x, getPulseVersions(y).history, {
				peerVersion: 2,
				mode: "history",
			}),
		);
		assert(
			JSON.stringify(getPulseVersions(y).state) ===
				JSON.stringify(getPulseVersions(y).history),
			"State history backfill failed",
		);
	} finally {
		destroyPulse(x);
		if (y) destroyPulse(y);
	}
	const Inline = definePulse("RuntimeInlineRich", {
		_type: "object",
		fields: {
			body: richText(),
			items: {
				_type: "array",
				element: { _type: "object", fields: { text: richText() } },
			},
		},
	}).materialize();
	const richA = createPulse(
		Inline,
		{ body: "Hello", items: [{ text: "Nested" }] },
		{ scope: createPulseScope(), connectors: [connector] },
	);
	let richB;
	try {
		await connectPulse(richA).synced;
		richB = await loadPulse(Inline, richA.id, {
			scope: createPulseScope(),
			connectors: [connector],
			waitFor: "all",
		});
		disconnectPulse(richA);
		disconnectPulse(richB);
		richA.body.insert(5, "!");
		richA.body.format(0, 5, { bold: true });
		richA.items[0].text.insert(6, "!");
		applyPulseUpdates(
			richB,
			exportPulseUpdates(richA, getPulseMeta(richB).log.vector),
		);
		assert(
			richB.body.text === "Hello!" && richB.items[0].text.text === "Nested!",
			"Inline rich text did not synchronize",
		);
		assert(
			richB.body.toDelta()[0].attributes.bold === true,
			"Inline rich text lost formatting",
		);
		assert(
			snapshotPulse(richB).body === "Hello!",
			"Inline rich text snapshot must contain a string",
		);
	} finally {
		destroyPulse(richA);
		if (richB) destroyPulse(richB);
	}
	return {
		ok: true,
		runtime:
			typeof navigator !== "undefined"
				? navigator.userAgent
				: (globalThis.process?.version ?? "unknown"),
	};
}
if (typeof window === "undefined") console.log(JSON.stringify(await smoke()));
