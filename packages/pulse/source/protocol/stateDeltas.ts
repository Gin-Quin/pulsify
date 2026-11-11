import { array, object, tuple, union } from "@gin-quin/codec";
import { OPERATIONS_VERSION } from "./versions.js";
import { wireCodec } from "./wireCodec.js";
import type { PulseMessage } from "../connection/PulseMessage.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import {
	validateVector,
	type PulseVersionVector,
} from "../connection/PulseVersionVector.js";
import { validateDocId } from "./validateDocId.js";
import { PulseError } from "./errors.js";
import { MAX_PATCH_BYTES, MAX_VECTOR_ENTRIES } from "./limits.js";
import {
	runOperationSize,
	runOperation,
	type ScalarRun,
} from "./scalarRuns.js";
export const STATE_THRESHOLD = 32;
const vv = array(tuple("uint", "uint"));
const deltaSchema = object({
	sid: "uint",
	clock: "uint",
	count: "uint",
	lamport: "uint",
	schema: "string",
	target: "string",
	field: union(["string", "uint"]),
	layout: "uint",
	external: vv,
	data: "uint8Array",
});
const common = { docId: "string", requestId: "uint", vv } as const;
const codec = wireCodec(
	object({
		protocolVersion: "uint",
		operationsVersion: "uint",
		message: union({
			tagName: "kind",
			tagType: "uint",
			variants: {
				1: { ...common, historyOnly: "boolean" },
				2: {
					...common,
					found: "boolean",
					complete: "boolean",
					delta: deltaSchema,
				},
				4: { ...common, delta: deltaSchema },
			},
		}),
	}),
);
export interface StateDelta {
	readonly docId: string;
	readonly sid: number;
	readonly clock: number;
	readonly count: number;
	readonly lamport: number;
	readonly schema: string;
	readonly target: string;
	readonly field: string | number;
	readonly layout: number;
	readonly external: PulseVersionVector;
	readonly data: Uint8Array;
	readonly bytes: number;
}
const states = new WeakMap<PulsePatchRow[], StateDelta>();
const requests: WeakMap<PulseMessage, boolean> = new WeakMap();
export const stateDeltaOf = (rows: PulsePatchRow[]): StateDelta | undefined =>
	states.get(rows);
export const isStateMessage = (message: PulseMessage): boolean =>
	"rows" in message && states.has(message.rows);
export const historyRequestOf = (message: PulseMessage): boolean | undefined =>
	requests.get(message);
const safe = (n: number, min = 0) => Number.isSafeInteger(n) && n >= min;
export function validateDelta(delta: StateDelta): void {
	validateDocId(delta.docId);
	validateVector(delta.external);
	if (
		!safe(delta.sid, 65536) ||
		!safe(delta.clock, 1) ||
		!safe(delta.count, 1) ||
		delta.count > 100000 ||
		!safe(delta.lamport, 1) ||
		!safe(delta.clock + delta.count) ||
		!safe(delta.lamport + delta.count) ||
		!safe(delta.layout) ||
		!delta.schema.isWellFormed() ||
		!delta.target.isWellFormed() ||
		(typeof delta.field === "number"
			? !safe(delta.field)
			: !delta.field.isWellFormed()) ||
		delta.external.some(([sid]) => sid === delta.sid) ||
		delta.external.length + 1 > MAX_VECTOR_ENTRIES ||
		!delta.data.length ||
		delta.data.length > MAX_PATCH_BYTES ||
		runOperationSize(delta, delta.count - 1, delta.data.length) >
			MAX_PATCH_BYTES
	)
		throw new PulseError("INVALID_MESSAGE", "Invalid state delta");
}
export function decodeStateMessage(bytes: Uint8Array): PulseMessage {
	const owned = new Uint8Array(bytes),
		decoded = codec.decode(owned);
	if (
		decoded.protocolVersion !== 3 ||
		decoded.operationsVersion !== OPERATIONS_VERSION
	)
		throw new PulseError("UNSUPPORTED_VERSION", "Unsupported state version");
	const canonical = codec.encode(decoded);
	if (
		canonical.length !== owned.length ||
		canonical.some((b, i) => b !== owned[i])
	)
		throw new PulseError("INVALID_MESSAGE", "Noncanonical state frame");
	const m = decoded.message;
	validateDocId(m.docId);
	validateVector(m.vv);
	if (!safe(m.requestId))
		throw new PulseError("INVALID_MESSAGE", "Invalid request ID");
	if (m.kind === 1) {
		const message: PulseMessage = {
			kind: 1,
			docId: m.docId,
			requestId: m.requestId,
			vv: m.vv,
		};
		requests.set(message, m.historyOnly);
		return message;
	}
	const d = m.delta;
	const delta: StateDelta = {
		...d,
		docId: m.docId,
		bytes:
			owned.length +
			d.external.length * 16 +
			(m.docId.length + d.schema.length + d.target.length) * 2 +
			96,
	};
	validateDelta(delta);
	const covered = new Map(m.vv);
	if (
		(covered.get(delta.sid) ?? 0) < delta.clock + delta.count ||
		!delta.external.every(([sid, c]) => (covered.get(sid) ?? 0) >= c)
	)
		throw new PulseError(
			"INVALID_MESSAGE",
			"State vector does not cover its delta",
		);
	const rows: PulsePatchRow[] = [];
	Object.freeze(rows);
	states.set(rows, delta);
	return m.kind === 2
		? {
				kind: 2,
				docId: m.docId,
				requestId: m.requestId,
				vv: m.vv,
				found: m.found,
				complete: m.complete,
				rows,
			}
		: { kind: 4, docId: m.docId, requestId: m.requestId, vv: m.vv, rows };
}
export function encodeStateMessage(
	message: Extract<PulseMessage, { rows: PulsePatchRow[] }>,
	delta: StateDelta,
): Uint8Array<ArrayBuffer> {
	validateDelta(delta);
	validateVector(message.vv);
	if (
		message.docId !== delta.docId ||
		!safe(message.requestId) ||
		(message.kind !== 2 && message.kind !== 4)
	)
		throw new PulseError("INVALID_MESSAGE", "Invalid state message");
	const {
		sid,
		clock,
		count,
		lamport,
		schema,
		target,
		field,
		layout,
		external,
		data,
	} = delta;
	const deltaWire = {
		sid,
		clock,
		count,
		lamport,
		schema,
		target,
		field,
		layout,
		external,
		data,
	};
	const common = {
		docId: message.docId,
		requestId: message.requestId,
		vv: message.vv,
		delta: deltaWire,
	};
	const body =
		message.kind === 2
			? {
					...common,
					kind: 2 as const,
					found: message.found,
					complete: message.complete,
				}
			: { ...common, kind: 4 as const };
	return codec.encode({
		protocolVersion: 3,
		operationsVersion: OPERATIONS_VERSION,
		message: body,
	});
}
export function encodeHistoryRequest(
	message: Extract<PulseMessage, { kind: 1 }>,
	historyOnly: boolean,
): Uint8Array<ArrayBuffer> {
	validateDocId(message.docId);
	validateVector(message.vv);
	if (!safe(message.requestId))
		throw new PulseError("INVALID_MESSAGE", "Invalid request ID");
	return codec.encode({
		protocolVersion: 3,
		operationsVersion: OPERATIONS_VERSION,
		message: { ...message, historyOnly },
	});
}
export function stateLastRow(delta: StateDelta): PulsePatchRow {
	const last = delta.clock + delta.count - 1,
		run: ScalarRun = {
			...delta,
			clock: last,
			count: 1,
			lamport: delta.lamport + delta.count - 1,
			source: delta.data,
			spans: new Uint32Array([0, delta.data.length]),
			expandedBytes: delta.data.length,
		};
	const deps = delta.external.map(([sid, clock]): [number, number] => [
		sid,
		clock,
	]);
	if (last > 1) {
		const at = deps.findIndex(([sid]) => sid > delta.sid);
		deps.splice(at < 0 ? deps.length : at, 0, [delta.sid, last]);
	}
	return {
		docId: delta.docId,
		sid: delta.sid,
		clock: last,
		span: 1,
		dependencies: deps,
		operations: runOperation(run, 0),
	};
}
export function clipState(delta: StateDelta, clock: number): StateDelta {
	const skip = Math.max(0, clock - delta.clock);
	return {
		...delta,
		clock: delta.clock + skip,
		lamport: delta.lamport + skip,
		count: delta.count - skip,
	};
}
export function sameStateHeader(a: StateDelta, b: StateDelta): boolean {
	return (
		a.sid === b.sid &&
		a.schema === b.schema &&
		a.target === b.target &&
		a.field === b.field &&
		a.layout === b.layout &&
		a.lamport - a.clock === b.lamport - b.clock &&
		a.external.length === b.external.length &&
		a.external.every(
			([sid, c], i) => sid === b.external[i]![0] && c === b.external[i]![1],
		)
	);
}
