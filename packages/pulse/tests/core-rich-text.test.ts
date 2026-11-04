import { describe, expect, test } from "bun:test";
import { array, map, object, optional } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	type Pulse,
	type PulseProperties,
} from "../source/index.js";
import { richText, type RichText } from "../source/core/richText.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import {
	encodeMessage,
	decodeMessage,
} from "../source/connection/PulseMessage.js";
import type { PulsePatchRow } from "../source/connection/PulsePatch.js";

type TextDocument = PulseProperties<"RichDocument"> & {
	body: RichText;
	title: string;
};
const TextDocument = definePulse<TextDocument>("RichDocument").materialize();
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});

function transfer(target: Pulse<TextDocument>, rows: PulsePatchRow[]): void {
	if (!rows.length) return;
	const message = decodeMessage(
		encodeMessage({
			kind: 4,
			docId: rows[0]!.docId,
			requestId: 0,
			vv: [],
			rows,
		}),
	);
	if (message.kind !== 4) throw new Error("Expected update message");
	getPulseMeta(target).applyRows(message.rows);
}

describe("collaborative rich text", () => {
	test("initial markers are immutable and use Unicode code points", () => {
		const value = richText("A😀é");
		expect(value.text).toBe("A😀é");
		expect(value.length).toBe(3);
		expect([...value]).toEqual(["A", "😀", "é"]);
		expect(value.toDelta()).toEqual([{ insert: "A😀é" }]);
		expect(JSON.stringify(value)).toBe('"A😀é"');
		expect(() => value.insert(0, "B")).toThrow("Attach");
		expect(() => richText("\ud800")).toThrow("Unicode");
	});

	test("insertions, deletions and formatting share one stable text view", () => {
		const pulse = createPulse(
			TextDocument,
			{ id: "rich-edit", title: "Rich", body: richText("A😀B") },
			options(65536),
		);
		try {
			const text = pulse.body;
			expect(text.length).toBe(3);
			text.insert(2, "é");
			expect(text.toString()).toBe("A😀éB");
			text.delete(1, 1);
			expect(text.text).toBe("AéB");
			text.format(0, 2, { bold: true });
			text.format(1, 2, { italic: true });
			expect(text.toDelta()).toEqual([
				{ insert: "A", attributes: { bold: true } },
				{ insert: "é", attributes: { bold: true, italic: true } },
				{ insert: "B", attributes: { italic: true } },
			]);
			text.format(1, 1, { bold: null });
			expect(text.toDelta()).toEqual([
				{ insert: "A", attributes: { bold: true } },
				{ insert: "éB", attributes: { italic: true } },
			]);
			expect(pulse.body).toBe(text);
			expect(snapshotPulse(pulse).body).toBe("AéB");
			text.insert(1, "Z", { color: "red" });
			expect(text.toDelta()[1]).toEqual({
				insert: "Z",
				attributes: { color: "red" },
			});
		} finally {
			destroyPulse(pulse);
		}
	});

	test("concurrent insertions and per-attribute formatting converge through binary transport", () => {
		const a = createPulse(
			TextDocument,
			{ id: "rich-converge", title: "Rich", body: richText("ab") },
			options(65536),
		);
		const b = createRuntime(
			TextDocument,
			a.id,
			options(65537),
		) as Pulse<TextDocument>;
		const c = createRuntime(
			TextDocument,
			a.id,
			options(65538),
		) as Pulse<TextDocument>;
		try {
			transfer(b, getPulseMeta(a).log.missing([]));
			transfer(c, getPulseMeta(a).log.missing([]));
			a.body.insert(1, "XYZ");
			b.body.insert(1, "123");
			a.body.format(0, 1, { bold: true, color: "red" });
			b.body.format(0, 1, { italic: true, color: "blue" });
			const rows = [a, b].flatMap((pulse) =>
				getPulseMeta(pulse).log.missing([]),
			);
			for (const target of [a, b, c]) {
				for (const row of [...rows].reverse()) transfer(target, [row]);
				transfer(target, rows);
				expect(getPulseMeta(target).log.pendingCount).toBe(0);
			}
			expect(a.body.text).toContain("XYZ");
			expect(a.body.text).toContain("123");
			expect(a.body.text).toBe(b.body.text);
			expect(a.body.text).toBe(c.body.text);
			expect(a.body.toDelta()).toEqual(b.body.toDelta());
			expect(a.body.toDelta()).toEqual(c.body.toDelta());
			expect(a.body.toDelta()[0]!.attributes).toEqual({
				bold: true,
				color: "blue",
				italic: true,
			});
		} finally {
			for (const pulse of [a, b, c]) destroyPulse(pulse);
		}
	});

	test("invalid edits leave state and the version vector untouched", () => {
		const pulse = createPulse(
			TextDocument,
			{ id: "rich-invalid", title: "Rich", body: richText("abc") },
			options(65536),
		);
		try {
			const before = getPulseMeta(pulse).log.vector;
			expect(() => pulse.body.insert(-1, "x")).toThrow();
			expect(() => pulse.body.insert(4, "x")).toThrow();
			expect(() => pulse.body.insert(0, "\ud800")).toThrow();
			expect(() => pulse.body.delete(0, -1)).toThrow();
			expect(() => pulse.body.format(0, 1, { bad: () => 1 })).toThrow();
			expect(() => pulse.body.insert(0, "x", { bad: () => 1 })).toThrow();
			expect(pulse.body.text).toBe("abc");
			expect(getPulseMeta(pulse).log.vector).toEqual(before);
		} finally {
			destroyPulse(pulse);
		}
	});

	test("replaced and destroyed text views reject further edits", () => {
		const pulse = createPulse(
			TextDocument,
			{ id: "rich-replaced", title: "Rich", body: richText("a") },
			options(65536),
		);
		const old = pulse.body;
		pulse.body = richText("b");
		expect(() => old.insert(0, "x")).toThrow("replaced or removed");
		const current = pulse.body;
		destroyPulse(pulse);
		expect(() => current.insert(0, "x")).toThrow();
	});

	test("a codec string schema can expose collaborative text using an annotation", () => {
		const schema = object({ body: "string", title: "string" });
		const definition = definePulse("TypedRich", schema, {
			richTextPaths: [["body"]],
		}).materialize();
		const pulse = createPulse(
			definition,
			{ id: "typed-rich", title: "Typed", body: richText("Hi") },
			options(65536),
		);
		try {
			pulse.body.insert(2, "!");
			expect(pulse.body.text).toBe("Hi!");
			expect(snapshotPulse(pulse).body).toBe("Hi!");
		} finally {
			destroyPulse(pulse);
		}
	});

	test("array and map terminal annotations expose editable text entries and replay", () => {
		const schema = object({
			items: array(optional("string")),
			byId: map("string"),
		});
		const definition = definePulse("TerminalRichText", schema, {
			richTextPaths: [
				["items", "*"],
				["byId", "*"],
			],
		}).materialize();
		const pulse = createPulse(
			definition,
			{
				id: "terminal-rich-text",
				items: [undefined, "Hello"],
				byId: { first: "Map" },
			},
			options(65536),
		);
		const restored = createRuntime(definition, pulse.id, options(65537));
		try {
			expect(pulse.items[0]).toBeUndefined();
			pulse.items[1]!.insert(5, "!");
			pulse.items.push(richText("New"));
			pulse.byId["first"]!.format(0, 3, { bold: true });
			const rows = getPulseMeta(pulse).log.missing([]);
			getPulseMeta(restored).applyRows(rows);
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(pulse));
			expect(restored["items"][1].text).toBe("Hello!");
			expect(restored["byId"]["first"].toDelta()).toEqual(
				pulse.byId["first"]!.toDelta(),
			);
		} finally {
			destroyPulse(pulse);
			destroyPulse(restored);
		}
	});

	test("array and map terminal constant entries reject nested edits", () => {
		const item = object({ id: "string", count: "uint" });
		const schema = object({ items: array(item), byId: map(item) });
		const definition = definePulse("TerminalConstants", schema, {
			constantPaths: [
				["items", "*"],
				["byId", "*"],
			],
		}).materialize();
		const pulse = createPulse(
			definition,
			{
				id: "terminal-constants",
				items: [{ id: "a", count: 1 }],
				byId: { first: { id: "b", count: 2 } },
			},
			options(65536),
		);
		try {
			const vector = getPulseMeta(pulse).log.vector;
			expect(() => Reflect.set(pulse.items[0]!, "count", 4)).toThrow();
			expect(() => Reflect.set(pulse.byId["first"]!, "count", 4)).toThrow();
			expect(getPulseMeta(pulse).log.vector).toEqual(vector);
			pulse.items[0] = { id: "new", count: 3 };
			expect(pulse.items[0]!.count).toBe(3);
			expect(() => Reflect.set(pulse.items[0]!, "count", 4)).toThrow();
		} finally {
			destroyPulse(pulse);
		}
	});
});
