import {
	validateVector,
	type PulsePatchRow,
} from "../../packages/pulse/source/protocol.js";
import { validateRows } from "../../packages/pulse/source/storage/rows.js";
import { pack, sameSegment, unpack } from "./segments.js";
import type { Segment, SegmentRepository, Vector } from "./types.js";

/** Benchmark storage policy. Backend adapters contain only database mechanics. */
export class BenchmarkStore {
	constructor(readonly repository: SegmentRepository) {}
	async append(rows: PulsePatchRow[]): Promise<void> {
		const docId = validateRows(rows);
		if (!docId) return;
		const segments = rows.map((row) => pack([row]));
		await this.repository.transact(docId, async (tx) => {
			const frontier = new Map(await tx.vector());
			for (const segment of segments) {
				const existing = await tx.get(segment.sid, segment.start);
				if (sameSegment(existing, segment)) continue;
				if (existing) throw new Error("Conflicting segment");
				if (
					segment.start !== (frontier.get(segment.sid) ?? 1) ||
					segment.dependencies.some(
						([sid, clock]) => (frontier.get(sid) ?? 0) < clock,
					)
				)
					throw new Error("Gap or unmet causal dependency");
				await tx.put(segment);
				frontier.set(segment.sid, segment.end);
			}
			await tx.setVector([...frontier].sort((a, b) => a[0] - b[0]));
		});
	}
	async read(docId: string, remote: Vector = []) {
		validateVector(remote);
		const segments = await this.repository.transact(docId, (tx) =>
			tx.read(remote),
		);
		const clocks = new Map(remote);
		return {
			rows: segments
				.flatMap(unpack)
				.filter((row) => row.clock + row.span > (clocks.get(row.sid) ?? 0)),
			segments: segments.length,
			payloadBytes: segments.reduce(
				(n, segment) => n + segment.payload.length,
				0,
			),
		};
	}
	vector(docId: string): Promise<Vector> {
		return this.repository.transact(docId, (tx) => tx.vector());
	}
	/** Closed history only: leave the newest segment of each actor available to appenders. */
	async planCompaction(
		docId: string,
	): Promise<{ sources: Segment[]; replacement: Segment }[]> {
		const segments = await this.repository.transact(docId, (tx) => tx.read([]));
		const actors = new Map<number, Segment[]>();
		for (const segment of segments) {
			const list = actors.get(segment.sid) ?? [];
			list.push(segment);
			actors.set(segment.sid, list);
		}
		return [...actors.values()].flatMap((list) => {
			const sources = list.slice(0, -1);
			return sources.length < 2
				? []
				: [{ sources, replacement: pack(sources.flatMap(unpack), true) }];
		});
	}
	/** Compare exact source fingerprints inside the replacement transaction (no blind overwrite). */
	async replace(
		docId: string,
		sources: Segment[],
		replacement: Segment,
	): Promise<boolean> {
		return this.repository.transact(docId, async (tx) => {
			for (const source of sources)
				if (!sameSegment(await tx.get(source.sid, source.start), source))
					return false;
			for (const source of sources) await tx.remove(source);
			await tx.put(replacement);
			return true;
		});
	}
	async compact(docId: string) {
		const plans = await this.planCompaction(docId);
		let replaced = 0;
		for (const { sources, replacement } of plans) {
			if (!(await this.replace(docId, sources, replacement)))
				throw new Error("Compaction conflict; retry later");
			replaced += sources.length - 1;
		}
		return replaced;
	}
}
