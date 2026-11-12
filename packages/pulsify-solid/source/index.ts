import {
	joinPresence,
	loadPulse,
	subscribePulse,
	type AnyPulseDefinition,
	type LoadPulseOptions,
	type ModelFromDefinition,
	type PresenceDefinition,
	type PresencePeer,
	type Pulse,
} from "pulsify-core";
import { createPulseViews } from "pulsify-core/bindings";
import {
	createResource,
	createSignal,
	getOwner,
	onCleanup,
	type Accessor,
	type ResourceReturn,
	type ResourceSource,
} from "solid-js";
import { isServer } from "solid-js/web";

/**
 * A view of the live pulse whose reads Solid tracks, as `createMutable` does
 * for a plain object: JSX, memos and effects that read it re-run after a
 * local or remote change. Writes go through to the pulse.
 *
 * Callable anywhere, with one view per pulse, which follows the pulse until
 * `destroyPulse`.
 */
export const createMutablePulse: <P extends Pulse<any>>(pulse: P) => P =
	createPulseViews((pulse) => {
		const [track, changed] = createSignal(undefined, { equals: false });
		subscribePulse(pulse, () => changed());
		return track;
	});

/**
 * A resource that loads the pulse of an ID, again when the ID changes, as a
 * view from `createMutablePulse`. Refuses to load on the server.
 */
export function createPulseResource<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: ResourceSource<string>,
	options?: LoadPulseOptions,
): ResourceReturn<Pulse<ModelFromDefinition<Definition>>> {
	return createResource(id, async (id) => {
		if (isServer)
			throw new Error(
				"createPulseResource loads on the client only; import the component with clientOnly",
			);
		return createMutablePulse(await loadPulse(definition, id, options));
	});
}

/** A signal of a pulse, which it stores as a view from `createMutablePulse`. */
export function createPulseSignal<P extends Pulse<any>>(
	initial?: P,
): readonly [Accessor<P | undefined>, (next: P | undefined) => void] {
	const [pulse, setPulse] = createSignal(
		initial && createMutablePulse(initial),
	);
	const set = (next: P | undefined) =>
		setPulse(() => next && createMutablePulse(next));
	return [pulse, set] as const;
}

/** What `createPulsePresence` returns: one presence channel of a pulse. */
export type PulsePresence<State> = {
	/** Everyone else in the channel. Unchanged peers keep the same object. */
	readonly others: readonly PresencePeer<State>[];
	/** What this session last set, or undefined. */
	readonly mine: State | undefined;
	/** Publish this session's state; undefined removes it. */
	set(state: State | undefined): void;
	/** Leave the channel now. Done for you when the owner is disposed. */
	leave(): void;
};

/**
 * Join a presence channel of a pulse. Reads of `others` and `mine` are
 * tracked: JSX, memos and effects that read them re-run when they change.
 * Created under an owner (a component, a root), it leaves the channel when
 * the owner is disposed; elsewhere, call `leave()` yourself.
 */
export function createPulsePresence<State>(
	pulse: Pulse<any>,
	definition: PresenceDefinition<State>,
): PulsePresence<State> {
	const handle = joinPresence(pulse, definition);
	const [track, changed] = createSignal(undefined, { equals: false });
	handle.subscribe(() => changed());
	if (getOwner()) onCleanup(() => handle.leave());
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
}
