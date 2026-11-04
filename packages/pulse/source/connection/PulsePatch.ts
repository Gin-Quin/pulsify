import {
	CorePatch,
	decodeCorePatch,
	encodeCorePatch,
	type CoreOperation,
	type ValueEncoding,
} from "../core/operations.js";
import type { PulseVersionVector } from "./PulseVersionVector.js";
export type PulsePatch = CorePatch;
export type PulsePatchRow = {
	docId: string;
	sid: number;
	clock: number;
	span: number;
	dependencies: PulseVersionVector;
	operations: Uint8Array;
};
export function patchToRow(
	docId: string,
	patch: CorePatch,
	dependencies: PulseVersionVector,
	encoding?: ValueEncoding,
): PulsePatchRow {
	return {
		docId,
		sid: patch.sid,
		clock: patch.clock,
		span: patch.span(),
		dependencies,
		operations: encodeCorePatch(patch, encoding),
	};
}
export function rowToPatch(
	row: PulsePatchRow,
	encoding?: ValueEncoding | ((schema: string) => ValueEncoding),
	schema?: string,
): CorePatch {
	return decodeCorePatch(row, encoding, schema);
}
export function encodeOperations(
	operations: CoreOperation[],
): Uint8Array<ArrayBuffer> {
	return encodeCorePatch(new CorePatch(65536, 1, 1, "", operations));
}
export function decodeOperations(bytes: Uint8Array): CoreOperation[] {
	return decodeCorePatch({
		docId: "",
		sid: 65536,
		clock: 1,
		span: 1,
		dependencies: [],
		operations: bytes,
	}).ops;
}
