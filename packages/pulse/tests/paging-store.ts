import { describe, expect, test } from "bun:test";
import type { PatchStore, StoredPatchRow } from "../source/storage.js";

const actor = 70001,
	other = 70002,
	third = 70003;
function row(docId: string, clock: number, sid: number): StoredPatchRow {
	return {
		docId,
		sid,
		clock,
		span: 1,
		dependencies: clock === 1 ? [] : [[sid, clock]],
		operations: new Uint8Array([clock, 0, 255]),
	};
}
// Build a valid varuint-encoded v3 kind-7 last-value write for arbitrary register index.
export const encodeValueOp = (
	registerId: number,
	lamport: number,
): Uint8Array => {
	const out: number[] = [];
	const pushUint = (n: number) => {
		for (; n >= 128; n = Math.floor(n / 128)) out.push((n % 128) | 128);
		out.push(n);
	};
	pushUint(3);
	pushUint(lamport);
	pushUint(0); // schema
	pushUint(1); // 1 op
	pushUint(7); // kind 7
	pushUint(1);
	out.push(114); // target "r"
	pushUint(1); // numeric field tag
	pushUint(registerId);
	pushUint(0); // layout
	pushUint(1);
	out.push(1);
	return Uint8Array.from(out);
};

type Page = Awaited<ReturnType<NonNullable<PatchStore["missingPage"]>>>;
/** Every page of a download, as a relay reads them, with `between` run after each one. */
async function readPages(
	store: PatchStore,
	docId: string,
	remote: Array<[number, number]>,
	options: { maxRows?: number; maxBytes?: number; maxNodes?: number },
	between: (page: number) => Promise<void> = async () => {},
): Promise<{ rows: StoredPatchRow[]; vv: Page["vv"]; pages: number }> {
	const rows: StoredPatchRow[] = [];
	let page: Page,
		after: unknown,
		pages = 0;
	do {
		page = await store.missingPage!(docId, remote, { ...options, after });
		if (page.next !== undefined) expect(page.rows.length).toBeGreaterThan(0);
		expect(page.rows.length).toBeLessThanOrEqual(options.maxRows ?? Infinity);
		rows.push(...page.rows);
		after = page.next;
		await between(++pages);
	} while (after !== undefined);
	return { rows, vv: page.vv, pages };
}
/** Each behind actor's rows run without a hole from at most its remote clock to its vector clock. */
function expectTiles(
	rows: StoredPatchRow[],
	remote: Array<[number, number]>,
	vv: Page["vv"],
): void {
	const since = new Map(remote);
	const behind = vv.filter(([sid, clock]) => clock > (since.get(sid) ?? 0));
	expect([...new Set(rows.map((r) => r.sid))].sort()).toEqual(
		behind.map(([sid]) => sid),
	);
	for (const [sid, frontier] of behind) {
		const own = rows.filter((r) => r.sid === sid);
		let end = own[0]!.clock;
		expect(end).toBeLessThanOrEqual(Math.max(since.get(sid) ?? 0, 1));
		for (const r of own) {
			expect(r.clock).toBe(end);
			end += r.span;
		}
		expect(end).toBe(frontier);
	}
}

/** `missingPage` against `missing`, for any store that pages its downloads. */
export function pagingStoreConformance(
	name: string,
	create: () => Promise<PatchStore>,
): void {
	describe(`${name} missingPage`, () => {
		test("pages tile what missing returns, within every budget", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			if (!store.missingPage) return;
			// History rows and last-value writes; rewritten registers leave holes.
			for (const sid of [actor, other, third])
				await store.append(
					Array.from({ length: 12 }, (_, i) => ({
						...row(docId, i + 1, sid),
						...(i % 3 ? { operations: encodeValueOp(i % 4, i + 1) } : {}),
					})),
				);
			const vector = await store.vector(docId);
			for (const remote of [
				[],
				[[actor, 5]],
				[
					[actor, 13],
					[other, 1],
					[third, 8],
				],
				[[other, 30]],
			] as Array<Array<[number, number]>>) {
				const missing = await store.missing(docId, remote);
				for (const options of [
					{},
					{ maxRows: 1 },
					{ maxRows: 2 },
					{ maxRows: 5 },
					{ maxBytes: 1 },
					{ maxNodes: 12 },
					{ maxRows: 3, maxBytes: 200 },
				]) {
					const paged = await readPages(store, docId, remote, options);
					expect(paged.rows).toEqual(missing);
					expect(paged.vv).toEqual(vector);
					if (options.maxRows === 1 || options.maxBytes === 1)
						expect(paged.pages).toBe(Math.max(missing.length, 1));
				}
				expectTiles(missing, remote, vector);
			}
		});
		test("stays consistent with appends between its pages", async () => {
			const store = await create(),
				docId = crypto.randomUUID();
			if (!store.missingPage) return;
			const history = (sid: number, from: number, to: number) =>
				Array.from({ length: to - from + 1 }, (_, i) => {
					const clock = from + i;
					return clock > 2
						? {
								...row(docId, clock, sid),
								operations: encodeValueOp(clock, clock),
							}
						: row(docId, clock, sid);
				});
			await store.append(history(actor, 1, 6));
			await store.append(history(other, 1, 3));
			const paged = await readPages(
				store,
				docId,
				[],
				{ maxRows: 2 },
				async (page) => {
					if (page === 1)
						// The value at 3, the end of the first page, is rewritten at 7.
						await store.append([
							{ ...row(docId, 7, actor), operations: encodeValueOp(3, 7) },
							...history(other, 4, 5),
						]);
					// Once the first actor is served, it keeps the frontier it was served to.
					if (page === 4) await store.append(history(actor, 8, 9));
				},
			);
			expectTiles(paged.rows, [], paged.vv);
			expect(paged.vv).toEqual([
				[actor, 8],
				[other, 6],
			]);
			expect(await store.vector(docId)).toEqual([
				[actor, 10],
				[other, 6],
			]);
		});
	});
}
