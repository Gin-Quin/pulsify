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
import { getCurrentScope, onScopeDispose, shallowRef } from "vue";

/**
 * A view of the live pulse whose reads Vue tracks, as `reactive` does for a
 * plain object: templates, `computed` and watchers that read it re-run after
 * a local or remote change. Writes go through to the pulse.
 *
 * Callable anywhere, with one view per pulse, which follows the pulse until
 * `destroyPulse`.
 */
export const reactivePulse: <P extends Pulse<any>>(pulse: P) => P =
	createPulseViews((pulse) => {
		const version = shallowRef(0);
		subscribePulse(pulse, () => version.value++);
		return () => void version.value;
	});

/** `reactivePulse(await loadPulse(…))`. */
export async function loadReactivePulse<Definition extends AnyPulseDefinition>(
	definition: Definition,
	id: string,
	options?: LoadPulseOptions,
): Promise<Pulse<ModelFromDefinition<Definition>>> {
	return reactivePulse(await loadPulse(definition, id, options));
}

/** `reactivePulse(createPulse(…))`. */
export function createReactivePulse<Definition extends AnyPulseDefinition>(
	definition: Definition,
	input: CreatePulseInput<DataFromDefinition<Definition>>,
	options?: CreatePulseOptions,
): Pulse<ModelFromDefinition<Definition>> {
	return reactivePulse(createPulse(definition, input, options));
}

/** What `usePulsePresence` returns: one presence channel of a pulse. */
export type PulsePresence<State> = {
	/** Everyone else in the channel. Unchanged peers keep the same object. */
	readonly others: readonly PresencePeer<State>[];
	/** What this session last set, or undefined. */
	readonly mine: State | undefined;
	/** Publish this session's state; undefined removes it. */
	set(state: State | undefined): void;
	/** Leave the channel now. Done for you when the scope is disposed. */
	leave(): void;
};

/**
 * Join a presence channel of a pulse. Reads of `others` and `mine` are
 * tracked, as with `reactive`: read them where you need them rather than
 * destructuring. Called in `setup` or any effect scope, it leaves the channel
 * when the scope is disposed; elsewhere, call `leave()` yourself.
 */
export function usePulsePresence<State>(
	pulse: Pulse<any>,
	definition: PresenceDefinition<State>,
): PulsePresence<State> {
	const handle = joinPresence(pulse, definition);
	const version = shallowRef(0);
	handle.subscribe(() => version.value++);
	if (getCurrentScope()) onScopeDispose(() => handle.leave());
	return {
		get others() {
			void version.value;
			return handle.others;
		},
		get mine() {
			void version.value;
			return handle.mine;
		},
		set: (state) => handle.set(state),
		leave: () => handle.leave(),
	};
}
