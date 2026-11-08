import {
	createPulse,
	createPulseScope,
	definePulse,
	getPulseMeta,
	type PulseProperties,
} from "../packages/pulse/source/index";
import {
	encodeMessage,
	type PulseMessage,
} from "../packages/pulse/source/connection/PulseMessage";
import { encodeOperations } from "../packages/pulse/source/connection/PulsePatch";
import type { CoreOperation } from "../packages/pulse/source/core/operations";
import type { PreparedValue } from "../packages/pulse/source/core/values";
// Intentionally run by a maintainer only when changing or extending the wire contract.
const Fixture = definePulse<PulseProperties<"Fixture"> & { value: number }>(
	"Fixture",
).materialize();
const pulse = createPulse(
	Fixture,
	{ id: "fixture", value: 1 },
	{ scope: createPulseScope(), sessionId: 65536 },
);
const rows = getPulseMeta(pulse).log.missing([]);
const vv = getPulseMeta(pulse).log.vector;
const messages: [string, PulseMessage][] = [
	["connect-empty", { kind: 1, docId: "fixture", requestId: 1, vv: [] }],
	[
		"connect-unicode-max-safe",
		{
			kind: 1,
			docId: "rust/🌍",
			requestId: Number.MAX_SAFE_INTEGER,
			vv: [
				[65536, 128],
				[Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
			],
		},
	],
	[
		"sync-not-found",
		{
			kind: 2,
			docId: "fixture",
			requestId: 1,
			found: false,
			complete: true,
			vv: [],
			rows: [],
		},
	],
	[
		"sync-document",
		{
			kind: 2,
			docId: "fixture",
			requestId: 1,
			found: true,
			complete: true,
			vv,
			rows,
		},
	],
	[
		"sync-page",
		{
			kind: 2,
			docId: "fixture",
			requestId: 1,
			found: true,
			complete: false,
			vv,
			rows,
		},
	],
	["sync-back", { kind: 3, docId: "fixture", requestId: 2, vv, rows }],
	["update", { kind: 4, docId: "fixture", requestId: 0, vv, rows }],
	["ack", { kind: 5, docId: "fixture", requestId: 2, vv }],
	[
		"error",
		{
			kind: 6,
			docId: "fixture",
			requestId: 3,
			code: "NOT_FOUND",
			message: "Missing document",
		},
	],
];
const prepared = (value: unknown): PreparedValue => ({
	value,
	constants: [],
	texts: [],
});
const operations: CoreOperation[] = [
	{ kind: 0, value: prepared(undefined) },
	{
		kind: 0,
		value: prepared({
			unicode: "é🌍",
			array: [null, undefined, true, -12.5, new Uint8Array([0, 255])],
		}),
	},
	{ kind: 1, target: "65536:1:0", field: "x", value: prepared([65536, 1]) },
	{ kind: 1, target: "65536:1:0", field: 0, value: prepared("typed slot") },
	{ kind: 2, target: "65536:1:0", field: "optional" },
	{
		kind: 3,
		target: "65536:1:1",
		after: "65536:1:2",
		deletes: ["65536:1:3"],
		values: [prepared("é🌍")],
	},
	{
		kind: 4,
		target: "65536:1:1",
		entry: "65536:1:2",
		value: prepared({ x: 2 }),
	},
	{
		kind: 5,
		target: "65536:1:4",
		entries: ["65536:1:5"],
		attributes: { bold: true, color: "red" },
	},
	{ kind: 6, target: "65536:1:1", entries: ["65536:1:2"], after: "65536:1:3" },
];
await Bun.write(
	"fixtures/protocol.json",
	`${JSON.stringify({ protocolVersion: 1, operationsVersion: 3, messages: messages.map(([name, message]) => ({ name, bytes: [...encodeMessage(message)] })), operations: [{ name: "all-operation-variants", bytes: [...encodeOperations(operations)] }] }, null, 2)}\n`,
);
