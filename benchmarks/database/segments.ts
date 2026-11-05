import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import {
	decodeMessage,
	encodeMessage,
	type PulsePatchRow,
} from "../../packages/pulse/source/protocol.js";
import type { Segment } from "./types.js";

export const fingerprint = (payload: Uint8Array): string =>
	createHash("sha256").update(payload).digest("hex");

/** A segment preserves exact Pulsify rows, including intermediate edits and dependencies. */
export function pack(rows: PulsePatchRow[], compress = false): Segment {
	const first = rows[0];
	if (!first) throw new Error("Cannot pack an empty segment");
	let end = first.clock;
	for (const row of rows) {
		if (row.docId !== first.docId || row.sid !== first.sid || row.clock !== end)
			throw new Error(
				"Segments must contain contiguous rows from one document/actor",
			);
		end = row.clock + row.span;
	}
	const frame = encodeMessage({
		kind: 4,
		docId: first.docId,
		requestId: 0,
		vv: [],
		rows,
	});
	const payload = compress
		? new Uint8Array(deflateSync(frame, { level: 6 }))
		: frame;
	return {
		docId: first.docId,
		sid: first.sid,
		start: first.clock,
		end,
		dependencies: first.dependencies,
		codec: compress ? "deflate" : "raw",
		payload,
		fingerprint: fingerprint(payload),
	};
}

export function unpack(segment: Segment): PulsePatchRow[] {
	if (fingerprint(segment.payload) !== segment.fingerprint)
		throw new Error("Corrupt segment");
	const bytes =
		segment.codec === "deflate"
			? new Uint8Array(
					inflateSync(segment.payload, { maxOutputLength: 16 * 1024 * 1024 }),
				)
			: segment.payload;
	const message = decodeMessage(bytes);
	if (!("rows" in message)) throw new Error("Segment is not Pulsify history");
	return message.rows;
}

export function sameSegment(a: Segment | undefined, b: Segment): boolean {
	return (
		!!a &&
		a.docId === b.docId &&
		a.sid === b.sid &&
		a.start === b.start &&
		a.end === b.end &&
		a.codec === b.codec &&
		a.fingerprint === b.fingerprint &&
		JSON.stringify(a.dependencies) === JSON.stringify(b.dependencies)
	);
}
