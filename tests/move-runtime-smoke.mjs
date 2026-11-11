import {
	arrayOperations,
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	disconnectPulse,
	getPulseMeta,
	loadPulse,
	richText,
	tree,
	decodeMessage,
	snapshotPulse,
} from "../packages/pulse/dist/index.js";

// Compile schemas and root codecs at module startup, as required by Workers.
const Definition = definePulse("RuntimeMoves", {
	_type: "object",
	fields: {
		object: { _type: "object", fields: { x: "uint" } },
		array: { _type: "array", element: "uint" },
		outline: tree({
			_type: "object",
			fields: { name: "string", body: richText() },
		}),
	},
}).materialize();
function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export async function moveSmoke() {
	const base = createMemoryConnector();
	let uploads = [];
	const connector = {
		kind: "local",
		async open(input) {
			const session = await base.open(input);
			return {
				...session,
				async send(bytes) {
					const message = decodeMessage(bytes);
					if (message.kind === 3) uploads.push(message.rows.length);
					return session.send(bytes);
				},
			};
		},
	};
	const a = createPulse(
		Definition,
		{ object: { x: 0 }, array: [], outline: {} },
		{
			scope: createPulseScope(),
			sessionId: 65536,
			connectors: [connector],
		},
	);
	let b;
	try {
		await connectPulse(a).synced;
		await new Promise((resolve) => setTimeout(resolve, 0));
		uploads = [];
		a.object.x = 12;
		a.array.push(13);
		assert(
			a.object.x === 12 && a.array[0] === 13 && uploads.length === 0,
			"Writes must apply synchronously before upload",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert(
			uploads.length === 1 && uploads[0] === 2,
			"Same-turn writes must produce one connector upload containing both rows",
		);
		const parent = a.outline.createNode({ name: "parent", body: "parent" });
		const child = parent.createNode({ name: "child", body: "child" });
		a.array.push(14);
		await getPulseMeta(a).connections[0].syncBack();
		b = await loadPulse(Definition, a.id, {
			scope: createPulseScope(),
			sessionId: 65537,
			connectors: [connector],
			waitFor: "all",
		});
		disconnectPulse(a);
		disconnectPulse(b);
		const payload = child.data;
		arrayOperations(a.array).move(0, 1);
		child.move();
		b.outline.getNode(child.id).data.body.insert(5, "!");
		await Promise.all([connectPulse(a).synced, connectPulse(b).synced]);
		assert(
			child.data === payload,
			"A tree move must preserve payload identity",
		);
		assert(
			JSON.stringify(snapshotPulse(a)) === JSON.stringify(snapshotPulse(b)),
			"Offline moves and concurrent edits must converge",
		);
		assert(
			b.array[1] === 13 && b.outline.getNode(child.id).parent() === undefined,
			"Array/tree moves were not synchronized",
		);
		assert(
			payload.body.text === "child!",
			"Concurrent rich-text edit was lost during reparenting",
		);
		return { batching: true, arrayMoves: true, treeMoves: true, offline: true };
	} finally {
		destroyPulse(a);
		if (b) destroyPulse(b);
	}
}
