import type { ClockVector } from "json-joy";
import type { Delta } from "json-joy/lib/json-crdt/delta/Delta";

export type ConnectionResponse = Promise<null | {
	delta: Delta;
	clockVector: ClockVector;
}>;
