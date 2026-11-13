import { describe, expect, test } from "bun:test";
import { array, map, object, optional } from "@gin-quin/codec";
import {
	compilePulseSchema,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	plainText,
	richText,
	schemaFingerprint,
	snapshotPulse,
	type PlainText,
	type Pulse,
} from "../source/index.js";
import { createPulseViews, plainTextContext } from "../source/bindings.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import {
	encodeMessage,
	decodeMessage,
} from "../source/connection/PulseMessage.js";

const Note = definePulse(
	"PlainNote",
	object({ title: "string", body: plainText() }),
).materialize();
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});

/** Send every row of `source` to `target` through the binary transport. */
function sync(source: Pulse<any>, target: Pulse<any>): void {
	const rows = getPulseMeta(source).log.missing([]);
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

function replicas(body: string) {
	const a = createPulse(
		Note,
		{ id: crypto.randomUUID(), title: "Note", body },
		options(65536),
	);
	const b = createRuntime(Note, a.id, options(65537)) as typeof a;
	sync(a, b);
	return { a, b };
}

describe("collaborative plain text", () => {
	test("reads like a string and edits by UTF-16 index", () => {
		const { a } = replicas("A😀é");
		const body: PlainText = a.body;
		expect(body.length).toBe(4);
		expect(`${body}`).toBe("A😀é");
		expect([...body]).toEqual(["A", "😀", "é"]);
		expect(JSON.stringify(a)).toContain('"body":"A😀é"');
		expect(snapshotPulse(a).body).toBe("A😀é");

		body.insert(3, "!");
		expect(body.text).toBe("A😀!é");
		body.replace(1, 2, "bc");
		expect(body.text).toBe("Abc!é");
		body.delete(3);
		expect(body.text).toBe("Abcé");
		body.delete(1, 99);
		expect(body.text).toBe("A");
		expect(a.body).toBe(body);
		expect("format" in body).toBe(false);
	});

	test("invalid edits are rejected and leave the text untouched", () => {
		const { a } = replicas("A😀");
		const rows = getPulseMeta(a).log.missing([]).length;
		expect(() => a.body.insert(2, "x")).toThrow("surrogate pair");
		expect(() => a.body.delete(1)).toThrow("surrogate pair");
		expect(() => a.body.insert(4, "x")).toThrow("out of bounds");
		expect(() => a.body.insert(-1, "x")).toThrow("out of bounds");
		expect(() => a.body.replace(0, -1, "x")).toThrow("count");
		expect(() => a.body.insert(0, "\ud800")).toThrow("Unicode");
		expect(() => {
			a.body = "\ud800" as never;
		}).toThrow("Unicode");
		expect(a.body.text).toBe("A😀");
		expect(getPulseMeta(a).log.missing([]).length).toBe(rows);
	});

	test("concurrent edits merge instead of one side winning", () => {
		const { a, b } = replicas("Hello world");
		// The offline side makes many edits, the other one a single edit.
		for (const char of " again") b.body.insert(b.body.length, char);
		a.body.insert(0, ">> ");
		sync(a, b);
		sync(b, a);
		expect(a.body.text).toBe(">> Hello world again");
		expect(b.body.text).toBe(a.body.text);
	});

	test("assigning a string edits only what changed", () => {
		const { a, b } = replicas("Je suis content");
		const view = a.body;
		// What a <textarea> does: assign its whole value on every input.
		a.body = plainText("hehehe\n\nJe suis content");
		// An untyped assignment of a string does the same.
		(b as { body: unknown }).body = "Je suis content\n\nBon ??";
		sync(a, b);
		sync(b, a);
		expect(a.body.text).toBe("hehehe\n\nJe suis content\n\nBon ??");
		expect(b.body.text).toBe(a.body.text);
		// The text was edited in place: its view is still attached.
		expect(a.body).toBe(view);

		const rows = getPulseMeta(a).log.missing([]).length;
		a.body = plainText(a.body.text);
		a.body = a.body;
		expect(getPulseMeta(a).log.missing([]).length).toBe(rows);
		a.body = plainText("");
		expect(a.body.text).toBe("");
		a.body = plainText("😀");
		expect(a.body.length).toBe(2);
	});

	test("anchors follow their character through edits", () => {
		const { a, b } = replicas("a😀c");
		const start = a.body.anchorAt(0),
			beforeC = a.body.anchorAt(3);
		b.body.insert(0, "123");
		sync(b, a);
		expect(a.body.indexOf(start)).toBe(0);
		expect(a.body.indexOf(beforeC)).toBe(6);
		a.body.delete(4, 2);
		expect(a.body.text).toBe("123ac");
		expect(a.body.indexOf(beforeC)).toBe(4);
		expect(a.body.indexOf("unknown")).toBeUndefined();
	});

	test("formatting sent by a peer is rejected", () => {
		const { a, b } = replicas("ab");
		const meta = getPulseMeta(a);
		meta.mutate([
			{
				kind: 5,
				target: meta.model.root!.child("body")!.id,
				entries: [a.body.anchorAt(1)],
				attributes: { bold: true },
			},
		]);
		expect(() => sync(a, b)).toThrow("Formatting requires rich text");
		expect(b.body.text).toBe("ab");
	});

	test("works in arrays, maps and optional fields, and replays", () => {
		const definition = definePulse(
			"PlainContainers",
			object({
				lines: array(plainText()),
				byId: map(plainText()),
				note: optional(plainText()),
			}),
		).materialize();
		const pulse = createPulse(
			definition,
			{ id: "plain-containers", lines: ["one", "two"], byId: { a: "map" } },
			options(65536),
		);
		const restored = createRuntime(definition, pulse.id, options(65537));
		try {
			const line = pulse.lines[1]!;
			pulse.lines[1] = plainText("two!");
			expect(pulse.lines[1]).toBe(line);
			pulse.lines.push(plainText("three"));
			pulse.lines[2]!.insert(0, "> ");
			pulse.byId["a"] = plainText("a map");
			pulse.byId["b"] = plainText("new");
			expect(pulse.note).toBeUndefined();
			pulse.note = plainText("created");
			pulse.note!.insert(7, "!");
			sync(pulse, restored as Pulse<any>);
			expect(snapshotPulse(restored as typeof pulse)).toEqual({
				...snapshotPulse(pulse),
				lines: ["one", "two!", "> three"],
				byId: { a: "a map", b: "new" },
				note: "created!",
			});
		} finally {
			destroyPulse(pulse);
			destroyPulse(restored);
		}
	});

	test("a field read through a framework view still binds", () => {
		const { a } = replicas("view");
		const view = createPulseViews(() => () => {})(a);
		let changes = 0;
		const unsubscribe = plainTextContext(view.body).subscribe(() => changes++);
		view.body = plainText("viewed");
		view.body.insert(0, "re");
		expect(a.body.text).toBe("reviewed");
		expect(changes).toBe(2);
		unsubscribe();
		expect(() => plainTextContext(plainText("detached"))).toThrow("attached");
	});

	test("its schema identity differs from a string and from rich text", () => {
		const fingerprint = (body: Parameters<typeof object>[0][string]) =>
			schemaFingerprint(compilePulseSchema(object({ body })));
		const identities = new Set([
			fingerprint("string"),
			fingerprint(richText()),
			fingerprint(plainText()),
		]);
		expect(identities.size).toBe(3);
		// Codec bytes are those of a plain string.
		const compiled = compilePulseSchema(object({ body: plainText() }));
		expect(compiled.codec.encode({ body: "Hi" } as never)).toEqual(
			compilePulseSchema(object({ body: "string" })).codec.encode({
				body: "Hi",
			}),
		);
	});
});
