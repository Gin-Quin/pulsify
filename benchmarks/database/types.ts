import type { PulseVersionVector } from "../../packages/pulse/source/protocol.js";

export type Vector = PulseVersionVector;
export type Segment = {
	docId: string;
	sid: number;
	start: number;
	end: number;
	dependencies: Vector;
	codec: "raw" | "deflate";
	payload: Uint8Array;
	fingerprint: string;
};

/** All reads are conflict-tracked. A failed callback rolls back every mutation. */
export interface SegmentTransaction {
	vector(): Promise<Vector>;
	setVector(vector: Vector): Promise<void>;
	get(sid: number, start: number): Promise<Segment | undefined>;
	read(remote: Vector): Promise<Segment[]>;
	put(segment: Segment): Promise<void>;
	remove(segment: Segment): Promise<void>;
}
export interface SegmentRepository {
	name: string;
	metadata: Record<string, unknown>;
	transact<T>(
		docId: string,
		work: (tx: SegmentTransaction) => Promise<T>,
	): Promise<T>;
	close(): Promise<void>;
}
