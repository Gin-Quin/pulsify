import {
	createPulse,
	joinPresence,
	loadPulse,
	subscribePulse,
	type AnyPulseDefinition,
	type CreatePulseInput,
	type CreatePulseOptions,
	type DataFromDefinition,
	type LoadPulseOptions,
	type ModelFromDefinition,
	type PresenceDefinition,
	type PresencePeer,
	type Pulse,
} from "pulsify-core";
import { createPulseViews } from "pulsify-core/bindings";
import { onDestroy } from "svelte";
import { createSubscriber } from "svelte/reactivity";

const view: <P extends Pulse<any>>(pulse: P) => P = createPulseViews((pulse) =>
	createSubscriber((update) => {
		// subscribePulse calls back at once: the reader is already up to date.
		let subscribed = false;
		const stop = subscribePulse(pulse, () => subscribed && update());
		subscribed = true;
		return stop;
	}),
);

/**
 * A view of the live pulse whose reads Svelte tracks, as `SvelteMap` does for
 * a `Map`: templates, `$derived` and `$effect` that read it re-run after a
 * local or remote change. Writes go through to the pulse.
 *
 * Callable anywhere, with one view per pulse: `new SveltePulse(pulse)` returns
 * the same object every time. The pulse is subscribed to only while an effect
 * reads it.
 */
export const SveltePulse = function (pulse: Pulse<any>) {
	return view(pulse);
} as unknown as new <P extends Pulse<any>>(pulse: P) => P;

/** `new SveltePulse(await loadPulse(…))`. */
export async function loadSveltePulse<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: string,
	options?: LoadPulseOptions,
): Promise<Pulse<ModelFromDefinition<Definition>>> {
	return view(await loadPulse(definition, id, options));
}

/** `new SveltePulse(createPulse(…))`. */
export function createSveltePulse<Definition extends AnyPulseDefinition>(
	definition: Definition,
	input: CreatePulseInput<DataFromDefinition<Definition>>,
	options?: CreatePulseOptions,
): Pulse<ModelFromDefinition<Definition>> {
	return view(createPulse(definition, input, options));
}

/** One presence channel of a pulse, whose reads Svelte tracks. */
export type SveltePresence<State> = {
	/** Everyone else in the channel. Unchanged peers keep the same object. */
	readonly others: readonly PresencePeer<State>[];
	/** What this session last set, or undefined. */
	readonly mine: State | undefined;
	/** Publish this session's state; undefined removes it. */
	set(state: State | undefined): void;
	/** Leave the channel now. Done for you when the component is destroyed. */
	leave(): void;
};

/**
 * Join a presence channel of a pulse: `new SveltePresence(pulse, Cursor)`.
 * Templates, `$derived` and `$effect` that read `others` or `mine` re-run
 * when they change. Created while a component initializes, it leaves the
 * channel when the component is destroyed; elsewhere, call `leave()`.
 */
export const SveltePresence = function <State>(
	pulse: Pulse<any>,
	definition: PresenceDefinition<State>,
): SveltePresence<State> {
	const handle = joinPresence(pulse, definition);
	const track = createSubscriber((update) => {
		// subscribe calls back at once: the reader is already up to date.
		let subscribed = false;
		const stop = handle.subscribe(() => subscribed && update());
		subscribed = true;
		return stop;
	});
	try {
		onDestroy(() => handle.leave());
	} catch {
		// Not in a component: the caller leaves.
	}
	return {
		get others() {
			track();
			return handle.others;
		},
		get mine() {
			track();
			return handle.mine;
		},
		set: (state) => handle.set(state),
		leave: () => handle.leave(),
	};
} as unknown as new <State>(
	pulse: Pulse<any>,
	definition: PresenceDefinition<State>,
) => SveltePresence<State>;
