import { getPulseMeta } from "../pulses/PulseMeta.js";
import type { Pulse } from "../pulses/Pulse.js";
import type { PresencePeer } from "./presence.js";

/**
 * An anchor naming an entry of a patch this pulse has not received yet:
 * entry IDs are `sid:clock:serial`, and the log's frontier is the next clock
 * of each session.
 */
function pending(pulse: Pulse<any>, anchor: string): boolean {
	const parts = anchor.split(":");
	if (parts.length !== 3) return false;
	const sid = Number(parts[0]),
		clock = Number(parts[1]);
	if (!Number.isSafeInteger(sid) || !Number.isSafeInteger(clock)) return false;
	const next = getPulseMeta(pulse).log.vector.find(([id]) => id === sid)?.[1];
	return clock >= (next ?? 1);
}

/**
 * Resolve the other peers' selections for an editor binding. A peer's
 * presence can arrive before the characters it names, as presence is relayed
 * at once and edits are not: until they arrive, its last selection that
 * resolved is drawn instead, for at most `holdMs`, then `expired` is called
 * so that the binding draws again. A selection of another field is dropped
 * at once.
 */
export function heldSelections<
	State extends { anchor: string; head: string },
	Resolved,
>(
	pulse: Pulse<any>,
	resolve: (state: State) => Resolved | undefined,
	expired: () => void,
	holdMs = 1500,
): {
	resolve(
		others: readonly PresencePeer<State>[],
	): { peer: number; state: State; resolved: Resolved }[];
	destroy(): void;
} {
	type Held = {
		state: State;
		timer?: ReturnType<typeof setTimeout>;
		expired?: true;
	};
	const held = new Map<number, Held>();
	const drop = (peer: number) => {
		clearTimeout(held.get(peer)?.timer);
		held.delete(peer);
	};
	return {
		resolve(others) {
			const drawn: { peer: number; state: State; resolved: Resolved }[] = [];
			const present = new Set<number>();
			for (const { peer, state } of others) {
				present.add(peer);
				const resolved = resolve(state);
				if (resolved !== undefined) {
					drop(peer);
					held.set(peer, { state });
					drawn.push({ peer, state, resolved });
					continue;
				}
				const last = held.get(peer);
				if (
					!last ||
					last.expired ||
					!(pending(pulse, state.anchor) || pending(pulse, state.head))
				) {
					drop(peer);
					continue;
				}
				last.timer ??= setTimeout(() => {
					last.expired = true;
					expired();
				}, holdMs);
				const previous = resolve(last.state);
				if (previous === undefined) drop(peer);
				else drawn.push({ peer, state: last.state, resolved: previous });
			}
			for (const peer of [...held.keys()]) if (!present.has(peer)) drop(peer);
			return drawn;
		},
		destroy() {
			for (const peer of [...held.keys()]) drop(peer);
		},
	};
}
