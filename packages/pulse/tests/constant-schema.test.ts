import { expect, test } from "bun:test";
import {
	applyPulseUpdates,
	array,
	compilePulseSchema,
	constant,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	frozen,
	getPulseMeta,
	object,
	optional,
	richText,
	schemaFingerprint,
	snapshotPulse,
	tuple,
} from "../source/index";
import { createRuntime } from "../source/pulses/PulseRuntime";
import { defaultPulseOptions } from "../source/pulses/PulseOptions";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage";
import type { PulsePatchRow } from "../source/connection/PulsePatch";

const config = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
function wire(rows: PulsePatchRow[]): PulsePatchRow[] {
	if (!rows.length) return [];
	const message = decodeMessage(
		encodeMessage({
			kind: 4,
			docId: rows[0]!.docId,
			requestId: 0,
			vv: [],
			rows,
		}),
	);
	if (message.kind !== 4) throw new Error("Expected a patch message");
	return message.rows;
}

const Board = definePulse(
	"ConstantBoard",
	object({
		origin: constant(tuple("float64", "float64")),
		label: optional(constant("string")),
		cursor: frozen(tuple("float64", object({ label: "string" }))),
		settings: frozen(object({ tags: array("string") })),
		points: array(frozen(tuple("float64", "float64"))),
		title: "string",
	}),
).materialize();
const initial = () => ({
	origin: [0, 0] as [number, number],
	label: "fixed",
	cursor: [1, { label: "a" }] as [number, { label: string }],
	settings: { tags: ["x"] },
	points: [[1, 2] as [number, number]],
	title: "Board",
});

test("constant fields can be neither replaced nor edited", () => {
	const board = createPulse(Board, initial(), config(65536));
	try {
		expect(() => {
			// @ts-expect-error constant fields are readonly
			board.origin = [1, 1];
		}).toThrow();
		expect(() => {
			// @ts-expect-error constant contents are readonly
			board.origin[0] = 1;
		}).toThrow();
		expect(() => {
			// @ts-expect-error optional constants are readonly too
			board.label = "changed";
		}).toThrow();
		expect(snapshotPulse(board).origin).toEqual([0, 0]);
		expect(board.label).toBe("fixed");
	} finally {
		destroyPulse(board);
	}
});

test("frozen fields are replaced as a whole and reject inner edits", () => {
	const board = createPulse(Board, initial(), config(65536));
	try {
		board.cursor = [2, { label: "b" }];
		board.settings = { tags: ["y", "z"] };
		board.points[0] = [3, 4];
		board.points.push([5, 6]);
		expect(snapshotPulse(board).cursor).toEqual([2, { label: "b" }]);
		expect(snapshotPulse(board).settings).toEqual({ tags: ["y", "z"] });
		expect(snapshotPulse(board).points).toEqual([
			[3, 4],
			[5, 6],
		]);
		const before = snapshotPulse(board);
		for (const edit of [
			// @ts-expect-error frozen contents are readonly
			() => (board.cursor[0] = 9),
			// @ts-expect-error frozen contents are deeply readonly
			() => (board.cursor[1].label = "changed"),
			// @ts-expect-error frozen arrays cannot grow
			() => board.settings.tags.push("w"),
			// @ts-expect-error frozen array elements are readonly
			() => (board.points[0]![0] = 9),
		])
			expect(edit).toThrow();
		expect(snapshotPulse(board)).toEqual(before);
	} finally {
		destroyPulse(board);
	}
});

test("frozen replacements converge and inner edits stay rejected on replicas", () => {
	const a = createPulse(Board, initial(), config(65536));
	const b = createRuntime(Board, a.id, config(65537)) as typeof a;
	try {
		getPulseMeta(b).applyRows(wire(getPulseMeta(a).log.missing([])));
		const vector = getPulseMeta(a).log.vector;
		a.cursor = [7, { label: "seven" }];
		getPulseMeta(b).applyRows(wire(getPulseMeta(a).log.missing(vector)));
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
		expect(() => ((b.cursor[1] as { label: string }).label = "x")).toThrow();
		expect(snapshotPulse(b).cursor).toEqual([7, { label: "seven" }]);
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("schema markers reject meaningless combinations", () => {
	expect(() => compilePulseSchema(object({ a: frozen("string") }))).toThrow(
		"frozen() requires a structured schema",
	);
	expect(() =>
		compilePulseSchema(object({ a: frozen(object({ body: richText() })) })),
	).toThrow("constant field cannot also be collaborative rich text");
	expect(() =>
		compilePulseSchema(
			// @ts-expect-error markers wrap concrete schemas
			object({ a: constant(richText()) }),
		),
	).toThrow("constant field cannot also be collaborative rich text");
});

test("inline constants fingerprint like path annotations", () => {
	const fields = { name: "string" as const, id: "string" as const };
	expect(
		schemaFingerprint(
			compilePulseSchema(object({ ...fields, id: constant("string") })),
		),
	).toBe(
		schemaFingerprint(
			compilePulseSchema(object(fields), { constantPaths: [["id"]] }),
		),
	);
});

test("migrations may freeze a field but not unfreeze it", () => {
	const plain = object({ s: object({ a: "string" }) });
	const locked = object({ s: frozen(object({ a: "string" })) });
	const migrate = (
		from: typeof plain | typeof locked,
		to: typeof plain | typeof locked,
	) => {
		const kind = `FrozenMigration${from === plain ? "Add" : "Remove"}`;
		const source = createPulse(
			definePulse(kind, from).materialize(),
			{ s: { a: "x" } },
			config(65536),
		);
		const latest = definePulse(kind, from)
			.migrateTo(to, (before) => ({ s: before.s }) as never)
			.materialize();
		const target = createRuntime(latest, source.id, config(65537));
		try {
			applyPulseUpdates(target, exportPulseUpdates(source, []));
			return target as unknown as { s: { a: string } };
		} finally {
			destroyPulse(source);
		}
	};
	const frozenTarget = migrate(plain, locked);
	expect(() => (frozenTarget.s.a = "y")).toThrow();
	frozenTarget.s = { a: "z" };
	expect(frozenTarget.s.a).toBe("z");
	expect(() => migrate(locked, plain)).toThrow(
		"Migration cannot make constant field s.a mutable",
	);
});
