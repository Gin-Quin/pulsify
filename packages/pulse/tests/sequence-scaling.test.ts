import { describe, expect, test } from "bun:test";
import { array, object } from "@gin-quin/codec";
import {
	applyPulseUpdates,
	arrayOperations,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	getPulseMeta,
	plainText,
	richText,
} from "../source/index.js";
import {
	RT_NODE,
	RT_PARENT,
	RT_TEXTBLOCK,
	RT_TYPE,
	connectEditorHistory,
	createPulsifyHistory,
	richTextContext,
} from "../source/bindings.js";
import type { CoreOperation } from "../source/core/operations.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";

const PlainNote = definePulse(
	"ScalingPlainNote",
	object({ body: plainText() }),
).materialize();
const RichNote = definePulse(
	"ScalingRichNote",
	object({ body: richText() }),
).materialize();
const ArrDoc = definePulse(
	"ScalingArrDoc",
	object({ items: array("int") }),
).materialize();

const opts = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});

describe("sequence, text and history scaling regressions", () => {
	test("Q1: plainText paste and delete scale linearly, not O(k*n)", () => {
		const measure = (n: number) => {
			const doc = createPulse(PlainNote, { body: "a".repeat(n) }, opts(65536));
			const chunk = "b".repeat(n / 5);
			const t0 = performance.now();
			doc.body.insert(n / 2, chunk);
			const pasteMs = performance.now() - t0;

			const t1 = performance.now();
			doc.body.delete(n / 4, n / 2);
			const deleteMs = performance.now() - t1;

			destroyPulse(doc);
			return { pasteMs, deleteMs };
		};
		// Warmup
		measure(2_000);
		const small = measure(10_000);
		const large = measure(40_000);
		// Quadratic O(k*n) grows ~16x from n to 4n; linear grows ~4x.
		expect(large.pasteMs / Math.max(small.pasteMs, 5)).toBeLessThan(10);
		expect(large.deleteMs / Math.max(small.deleteMs, 3)).toBeLessThan(10);
	});

	test("Q2: remote sequence validation does not copy all entry IDs", () => {
		const measure = (n: number) => {
			const a = createPulse(
				ArrDoc,
				{ items: Array.from({ length: n }, (_, i) => i) },
				opts(65536),
			);
			const b = createRuntime(ArrDoc, a.id, opts(65537)) as typeof a;
			applyPulseUpdates(b, exportPulseUpdates(a, []));
			let remoteMs = 0;
			for (let i = 0; i < 100; i++) {
				const vv = getPulseMeta(b).log.vector;
				a.items.push(i);
				const frames = exportPulseUpdates(a, vv);
				const t0 = performance.now();
				applyPulseUpdates(b, frames);
				remoteMs += performance.now() - t0;
			}
			destroyPulse(a);
			destroyPulse(b);
			return remoteMs;
		};
		measure(1_000);
		const small = measure(5_000);
		const large = measure(20_000);
		// O(n) validation per push grows ~4x from 5k to 20k; O(1) stays flat.
		expect(large / Math.max(small, 10)).toBeLessThan(3);
	});

	test("Q3: array push after a move does not rebuild the view per inserted item", () => {
		const measure = (n: number) => {
			const doc = createPulse(
				ArrDoc,
				{ items: Array.from({ length: n }, (_, i) => i) },
				opts(65536),
			);
			arrayOperations(doc.items).move(0, n - 1, 1);
			const batch = Array.from({ length: n / 10 }, (_, i) => i);
			const t0 = performance.now();
			doc.items.push(...batch);
			const batchMs = performance.now() - t0;
			destroyPulse(doc);
			return batchMs;
		};
		measure(1_000);
		const small = measure(5_000);
		const large = measure(20_000);
		// Rebuilding per inserted entry is O(k*n) = ~16x from 5k to 20k; linear is ~4x.
		expect(large / Math.max(small, 5)).toBeLessThan(10);
	});

	test("Q4: committing many formatting ops in one patch scales linearly", () => {
		const measure = (paragraphs: number) => {
			const doc = createPulse(RichNote, { body: "" }, opts(65536));
			const { node, model } = richTextContext(doc.body);
			const clock = model.nextClock;
			const sid = model.sid;
			const rootId = `${node.id}/root`;
			let serial = 0;
			const values: {
				value: string;
				constants: string[][];
				texts: string[][];
			}[] = [{ value: "\uFFFC", constants: [], texts: [] }];
			const rootAnchorId = `${sid}:${clock}:${serial++}`;
			const ops: CoreOperation[] = [
				{ kind: 3, target: node.id, after: "", deletes: [], values },
				{
					kind: 5,
					target: node.id,
					entries: [rootAnchorId],
					attributes: {
						[RT_NODE]: rootId,
						[RT_PARENT]: "",
						[RT_TYPE]: "doc",
						[RT_TEXTBLOCK]: false,
					},
				},
			];
			for (let p = 0; p < paragraphs; p++) {
				const pId = `p${p}`;
				const anchorId = `${sid}:${clock}:${serial++}`;
				values.push({ value: "\uFFFC", constants: [], texts: [] });
				const charIds: string[] = [];
				for (let c = 0; c < 100; c++) {
					charIds.push(`${sid}:${clock}:${serial++}`);
					values.push({ value: "x", constants: [], texts: [] });
				}
				ops.push(
					{
						kind: 5,
						target: node.id,
						entries: [anchorId],
						attributes: {
							[RT_NODE]: pId,
							[RT_PARENT]: rootId,
							[RT_TYPE]: "paragraph",
							[RT_TEXTBLOCK]: true,
						},
					},
					{
						kind: 5,
						target: node.id,
						entries: charIds,
						attributes: { [RT_PARENT]: pId },
					},
				);
			}
			const t0 = performance.now();
			model.commit(ops);
			const ms = performance.now() - t0;
			expect(doc.body.length).toBe(paragraphs * 100);
			destroyPulse(doc);
			return ms;
		};
		measure(50);
		const small = measure(200);
		const large = measure(800);
		// Syncing text on every op is O(paragraphs^2) = ~16x; syncing once per patch is ~4x.
		expect(large / Math.max(small, 5)).toBeLessThan(10);
	});

	test("Q5: editorHistory replay and delete recording scale linearly", () => {
		const measureReplay = (count: number) => {
			const doc = createPulse(
				RichNote,
				{ body: "a".repeat(count) },
				opts(65536),
			);
			const ctx = richTextContext(doc.body);
			const hist = createPulsifyHistory({ maxUndo: 100 });
			const conn = connectEditorHistory(hist, ctx, {
				flush() {},
				replay(action) {
					action();
				},
			});
			const entries = ctx.node.visible.map((e) => e.id);
			const pushFormat = (val: boolean) => {
				const before = entries.map((id) => ({
					id,
					val: ctx.node.entries.get(id)!.marks.get("bold")?.value ?? null,
					stamp: ctx.node.entries.get(id)!.marks.get("bold")?.stamp,
				}));
				ctx.model.commit([
					{ kind: 5, target: ctx.node.id, entries, attributes: { bold: val } },
				]);
				conn.record(
					{
						inserted: [],
						deleted: [],
						attributes: before.map((b) => ({
							entry: b.id,
							key: "bold",
							before: b.val,
							after: val,
							stamp: ctx.node.entries.get(b.id)!.marks.get("bold")!.stamp,
							beforeStamp: b.stamp,
						})),
					},
					{ push: true },
				);
			};
			pushFormat(true);
			pushFormat(false);
			pushFormat(true);
			pushFormat(false);
			const t0 = performance.now();
			hist.undo();
			const ms = performance.now() - t0;
			conn.destroy();
			destroyPulse(doc);
			return ms;
		};
		measureReplay(100);
		const smallReplay = measureReplay(400);
		const largeReplay = measureReplay(1_600);
		expect(largeReplay / Math.max(smallReplay, 4)).toBeLessThan(10);

		const measureDeletes = (docLen: number) => {
			const doc = createPulse(
				RichNote,
				{ body: "a".repeat(docLen) },
				opts(65536),
			);
			const ctx = richTextContext(doc.body);
			const hist = createPulsifyHistory({ maxUndo: 100 });
			const conn = connectEditorHistory(hist, ctx, {
				flush() {},
				replay(action) {
					action();
				},
			});
			const ids = ctx.node.visible
				.slice(docLen - 500)
				.map((e) => e.id)
				.reverse();
			const t0 = performance.now();
			for (let i = 0; i < ids.length; i++) {
				if (i % 50 === 0) hist.stopCapturing();
				const id = ids[i]!;
				ctx.node.entries.get(id)!.deleted = true;
				conn.record({ inserted: [], deleted: [id], attributes: [] });
			}
			const ms = performance.now() - t0;
			conn.destroy();
			destroyPulse(doc);
			return ms;
		};
		measureDeletes(2_000);
		const smallDel = measureDeletes(10_000);
		const largeDel = measureDeletes(40_000);
		// Scanning node.order per delete scales ~4x with docLen; O(1) stays flat.
		expect(largeDel / Math.max(smallDel, 15)).toBeLessThan(3);
	});

	test("Q6: unformatted rich-text entries share one empty marks sentinel", () => {
		const doc = createPulse(RichNote, { body: "a".repeat(1_000) }, opts(65536));
		doc.body.insert(500, "hello");
		const { node } = richTextContext(doc.body);
		const sentinel = node.visible[0]!.marks;
		expect(sentinel.size).toBe(0);
		for (const entry of node.visible) {
			expect(entry.marks).toBe(sentinel);
		}
		doc.body.format(10, 5, { bold: true });
		expect(sentinel.size).toBe(0);
		for (let i = 0; i < node.visible.length; i++) {
			const entry = node.visible[i]!;
			if (i >= 10 && i < 15) {
				expect(entry.marks).not.toBe(sentinel);
				expect(entry.marks.get("bold")?.value).toBe(true);
			} else {
				expect(entry.marks).toBe(sentinel);
			}
		}
		destroyPulse(doc);
	});
});
