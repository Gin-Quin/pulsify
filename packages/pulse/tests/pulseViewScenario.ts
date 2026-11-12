import { expect } from "bun:test";
import { array, object } from "@gin-quin/codec";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	loadPulse,
	PulseRelay,
	sub,
	pulseRef,
	type Pulse,
} from "pulsify-core";

const Task = definePulse("Task", object({ label: "string" })).materialize();
const Note = definePulse(
	"Note",
	object({
		title: "string",
		author: object({ name: "string" }),
		tags: array("string"),
		items: array(object({ label: "string" })),
		tasks: array(sub(Task)),
	}),
).materialize();

/**
 * What every framework wrapper built on `createPulseViews` must do. `effect`
 * runs a function now and again whenever what it read changed; `flush` waits
 * for the framework to have done so.
 */
export async function checkPulseViews(
	wrap: <P extends Pulse<any>>(pulse: P) => P,
	effect: (run: () => void) => void,
	flush: () => void = () => {},
): Promise<void> {
	const connector = createMemoryConnector(new PulseRelay());
	const options = { scope: createPulseScope(), connectors: [connector] };
	const pulse = createPulse(
		Note,
		{
			id: crypto.randomUUID(),
			title: "Draft",
			author: { name: "Ada" },
			tags: ["a"],
			items: [{ label: "A" }],
			tasks: [],
		},
		options,
	);
	const task = createPulse(Task, { label: "First" }, { parent: pulse });
	pulse.tasks.push(pulseRef(task));
	await Promise.all([connectPulse(pulse).synced, connectPulse(task).synced]);

	const note = wrap(pulse);
	expect(wrap(pulse)).toBe(note);
	expect(wrap(note)).toBe(note);
	expect(note.tasks[0]).toBe(note.tasks[0]);

	// A nested object handed to another reader keeps tracking.
	const author = note.author;
	const seen: string[] = [];
	effect(() => {
		seen.push(
			[
				note.title,
				author.name,
				note.tags.join(),
				note.items.map((item) => item.label).join(),
				note.tasks.map((handle) => handle.pulse?.label).join(),
			].join("|"),
		);
	});
	flush();
	expect(seen).toEqual(["Draft|Ada|a|A|First"]);

	// Writes through the view reach the pulse and re-run its readers.
	note.title = "Ready";
	flush();
	expect(pulse.title).toBe("Ready");
	expect(seen.at(-1)).toBe("Ready|Ada|a|A|First");
	author.name = "Grace";
	note.tags.push("b");
	note.items[0]!.label = "B";
	flush();
	expect(pulse.tags).toEqual(["a", "b"]);
	expect(seen.at(-1)).toBe("Ready|Grace|a,b|B|First");

	// A sub-pulse reached through the view is tracked on its own.
	note.tasks[0]!.pulse!.label = "Done";
	flush();
	expect(task.label).toBe("Done");
	expect(seen.at(-1)).toBe("Ready|Grace|a,b|B|Done");

	// So are changes made by another client.
	const other = await loadPulse(Note, pulse.id, {
		scope: createPulseScope(),
		connectors: [connector],
		waitFor: "all",
	});
	other.title = "Remote";
	await new Promise((resolve) => setTimeout(resolve, 20));
	flush();
	expect(seen.at(-1)).toBe("Remote|Grace|a,b|B|Done");
}
