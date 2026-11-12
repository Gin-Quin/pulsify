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
import {
	encodePresenceFrame,
	encodePresenceLeave,
	type PresenceFrame,
} from "../packages/pulse/source/protocol/presenceFrames";
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
const noState = new Uint8Array();
// Kind 7: relays forward these and never store them.
const presence: [string, PresenceFrame][] = [
	[
		"join-from-client",
		{
			docId: "fixture",
			peer: 0,
			to: 0,
			event: 0,
			subject: "",
			channel: "cursor#0a1b2c3d",
			state: noState,
		},
	],
	[
		"state-relayed",
		{
			docId: "rust/🌍",
			peer: 281474976710656,
			to: 0,
			event: 1,
			subject: "ada@example.com",
			channel: "cursor#0a1b2c3d",
			state: new Uint8Array([0, 0, 128, 63, 0, 0, 0, 64]),
		},
	],
	[
		"state-answering-a-join",
		{
			docId: "fixture",
			peer: 7,
			to: 9,
			event: 1,
			subject: "",
			channel: "viewer#ffffffff",
			state: new Uint8Array([3, 65, 100, 97]),
		},
	],
	[
		"clear",
		{
			docId: "fixture",
			peer: 7,
			to: 0,
			event: 2,
			subject: "",
			channel: "viewer#ffffffff",
			state: noState,
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
	`${JSON.stringify({ protocolVersion: 1, operationsVersion: 3, messages: messages.map(([name, message]) => ({ name, bytes: [...encodeMessage(message)] })), operations: [{ name: "all-operation-variants", bytes: [...encodeOperations(operations)] }], presence: [...presence.map(([name, frame]) => ({ name, bytes: [...encodePresenceFrame(frame)] })), { name: "leave", bytes: [...encodePresenceLeave("fixture", 7)] }] }, null, 2)}\n`,
);
