import { describe, expect, test } from "bun:test";
import {
	applyPulseUpdates,
	createPulse,
	definePulse,
	exportPulseUpdates,
	getPulseVersions,
	object,
	richText,
	RichTextSelection,
} from "../source/index";
import { createRuntime } from "../source/pulses/PulseRuntime";
import { defaultPulseOptions } from "../source/pulses/PulseOptions";
import { createPulseScope } from "../source/index";

const options = () => ({ ...defaultPulseOptions, scope: createPulseScope() });

const Note = definePulse(
	"AnchoredNote",
	object({ body: richText(), other: richText() }),
).materialize();
const note = (body = "Hello world") =>
	createPulse(Note, { body, other: "Other" }, options());

describe("rich text anchors", () => {
	test("an anchor follows its character through insertions and deletions", () => {
		const { body } = note();
		const caret = body.anchorAt(5);
		expect(body.indexOf(caret)).toBe(5);
		body.insert(0, "Hey, ");
		expect(body.indexOf(caret)).toBe(10);
		body.insert(body.length, "!");
		expect(body.indexOf(caret)).toBe(10);
		body.delete(0, 5);
		expect(body.indexOf(caret)).toBe(5);
	});

	test("text typed at an anchor lands after it", () => {
		const { body } = note();
		const caret = body.anchorAt(5);
		body.insert(5, ",");
		expect(body.indexOf(caret)).toBe(5);
		expect(body.text).toBe("Hello, world");
	});

	test("the start of a field is an anchor of that field", () => {
		const { body, other } = note();
		const start = body.anchorAt(0);
		body.insert(0, "Well. ");
		expect(body.indexOf(start)).toBe(0);
		expect(other.indexOf(start)).toBeUndefined();
		expect(note("").body.anchorAt(0)).not.toBe(start);
	});

	test("an anchor on a deleted character stays where the character was", () => {
		const { body } = note("abcdef");
		const caret = body.anchorAt(4);
		body.delete(2, 3);
		expect(body.text).toBe("abf");
		expect(body.indexOf(caret)).toBe(2);
		body.delete(0, 2);
		expect(body.indexOf(caret)).toBe(0);
	});

	test("anchors of another field or of unknown characters do not resolve", () => {
		const { body, other } = note();
		expect(body.indexOf(other.anchorAt(2))).toBeUndefined();
		expect(body.indexOf("999999:1:0")).toBeUndefined();
		expect(() => body.anchorAt(99)).toThrow(RangeError);
	});

	test("an anchor resolves on another replica, once its character arrived", () => {
		const a = note();
		const b = createRuntime(Note, a.id, options()) as typeof a;
		applyPulseUpdates(b, exportPulseUpdates(a, []));
		a.body.insert(5, " there");
		const caret = a.body.anchorAt(11);
		// Presence can overtake the document: the character is not here yet.
		expect(b.body.indexOf(caret)).toBeUndefined();
		applyPulseUpdates(b, exportPulseUpdates(a, getPulseVersions(b).state));
		expect(b.body.text).toBe("Hello there world");
		expect(b.body.indexOf(caret)).toBe(11);
		b.body.insert(0, ">> ");
		expect(b.body.indexOf(caret)).toBe(14);
	});

	test("the selection channel carries two anchors and how to show their owner", () => {
		expect(RichTextSelection.name).toBe("rich-text-selection");
		const state = { anchor: "a", head: "b", name: "Ada", color: "#f00" };
		expect(
			RichTextSelection.codec.decode(RichTextSelection.codec.encode(state)),
		).toEqual(state);
	});
});
