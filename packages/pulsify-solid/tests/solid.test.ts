import { expect, test } from "bun:test";
import { object } from "@gin-quin/codec";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePresence,
	definePulse,
	joinPresence,
	loadPulse,
	PulseRelay,
} from "pulsify-core";
import { createEffect, createRoot } from "solid-js";
import { checkPulseViews } from "../../pulse/tests/pulseViewScenario";
import {
	createMutablePulse,
	createPulsePresence,
	createPulseResource,
	createPulseSignal,
} from "../source/index";

// Run with `--conditions browser`: Solid's server build is not reactive.
test("createMutablePulse tracks reads and writes to the pulse", () =>
	checkPulseViews(createMutablePulse, (run) => {
		createRoot(() => createEffect(run));
	}));

const Note = definePulse("Note", object({ title: "string" })).materialize();

test("createPulseResource and createPulseSignal hold tracked views", async () => {
	const connector = createMemoryConnector();
	const options = { scope: createPulseScope(), connectors: [connector] };
	const source = createPulse(Note, { title: "Draft" }, options);
	await connectPulse(source).synced;

	const seen: (string | undefined)[] = [];
	const [, setCreated] = createRoot(() => {
		const [loaded] = createPulseResource(Note, source.id, {
			...options,
			scope: createPulseScope(),
			sessionId: 65540,
		});
		const [created, setCreated] = createPulseSignal<typeof source>();
		createEffect(() => seen.push(`${loaded()?.title}/${created()?.title}`));
		return [loaded, setCreated] as const;
	});
	const wait = async (text: string) => {
		for (let i = 0; i < 50 && seen.at(-1) !== text; i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(seen.at(-1)).toBe(text);
	};
	await wait("Draft/undefined");
	setCreated(
		createPulse(Note, { title: "New" }, { scope: createPulseScope() }),
	);
	await wait("Draft/New");
	source.title = "Remote";
	await wait("Remote/New");
});

const Viewer = definePresence("viewer", object({ name: "string" }), {
	throttleMs: 0,
});

test("createPulsePresence tracks others and mine, and leaves with its owner", async () => {
	const relay = new PulseRelay();
	const options = () => ({
		scope: createPulseScope(),
		connectors: [createMemoryConnector(relay)],
	});
	const mine = createPulse(Note, { title: "Draft" }, options());
	await connectPulse(mine).synced;
	const theirs = await loadPulse(Note, mine.id, {
		...options(),
		waitFor: "all",
	});
	const remote = joinPresence(theirs, Viewer);
	remote.set({ name: "Grace" });

	const seen: string[] = [];
	const [viewers, dispose] = createRoot((dispose) => {
		const viewers = createPulsePresence(createMutablePulse(mine), Viewer);
		createEffect(() =>
			seen.push(
				`${viewers.mine?.name}:${viewers.others.map((other) => other.state.name)}`,
			),
		);
		return [viewers, dispose] as const;
	});
	const wait = async (check: () => void) => {
		for (let i = 0; i < 100; i++) {
			try {
				return check();
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		}
		check();
	};
	await wait(() => expect(seen.at(-1)).toBe("undefined:Grace"));
	viewers.set({ name: "Ada" });
	await wait(() => expect(seen.at(-1)).toBe("Ada:Grace"));
	await wait(() =>
		expect(remote.others.map((other) => other.state.name)).toEqual(["Ada"]),
	);
	// Leaving by hand, while the effect is alive, shows in what it reads.
	viewers.leave();
	await wait(() => expect(seen.at(-1)).toBe("undefined:"));
	await wait(() => expect(remote.others).toEqual([]));
	dispose();
	expect(viewers.others).toEqual([]);

	// Without a manual leave, the owner does it.
	const disposeOther = createRoot((dispose) => {
		createPulsePresence(mine, Viewer).set({ name: "Again" });
		return dispose;
	});
	await wait(() => expect(remote.others).toHaveLength(1));
	disposeOther();
	await wait(() => expect(remote.others).toEqual([]));
});
