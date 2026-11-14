import { afterEach, expect, test } from "bun:test";
import {
	applyPulseUpdates,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	exportPulseUpdates,
	object,
	plainText,
	type Pulse,
} from "../source/index.js";
import { heldSelections } from "../source/bindings.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";

const Note = definePulse(
	"HeldSelectionNote",
	object({ body: plainText(), other: plainText() }),
).materialize();
const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
const pulses: Pulse<any>[] = [];
afterEach(() => {
	for (const pulse of pulses.splice(0)) destroyPulse(pulse);
});

test("a selection naming characters not received yet keeps the peer's last one until it expires", async () => {
	const a = createPulse(
		Note,
		{ body: "Hello", other: "Other" },
		options(71001),
	);
	const b = createRuntime(Note, a.id, options(71002)) as typeof a;
	pulses.push(a, b);
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	const at = (anchor: string) => ({ anchor, head: anchor });
	let expired = 0;
	const held = heldSelections(
		b,
		(state: { anchor: string; head: string }) => b.body.indexOf(state.head),
		() => expired++,
		20,
	);
	const drawn = (state: { anchor: string; head: string }) =>
		held.resolve([{ peer: 1, state }]).map(({ resolved }) => resolved);

	expect(drawn(at(a.body.anchorAt(3)))).toEqual([3]);
	// Typed in `a`, not received by `b` yet: the last selection stays.
	a.body.insert(5, "!");
	const typed = at(a.body.anchorAt(6));
	expect(drawn(typed)).toEqual([3]);
	applyPulseUpdates(b, exportPulseUpdates(a, []));
	expect(drawn(typed)).toEqual([6]);

	// Another field is received already: dropped at once.
	expect(drawn(at(a.other.anchorAt(2)))).toEqual([]);

	// A selection held too long is dropped, and the binding is told to draw.
	expect(drawn(typed)).toEqual([6]);
	a.body.insert(6, "?");
	const late = at(a.body.anchorAt(7));
	expect(drawn(late)).toEqual([6]);
	await new Promise((resolve) => setTimeout(resolve, 40));
	expect(expired).toBe(1);
	expect(drawn(late)).toEqual([]);
	held.destroy();
});
