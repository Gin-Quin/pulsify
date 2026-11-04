import {
  connectPulse, createMemoryConnector, createPulse, createPulseScope, definePulse,
  destroyPulse, loadPulse, snapshotPulse, type PulseProperties,
} from "@pulsify/core";
import { decodeMessage, encodeMessage, type PulseMessage } from "@pulsify/core/protocol";

type Doc = PulseProperties<"Consumer"> & { title: string; items: { value: number }[] };
const Doc = definePulse<Doc>("Consumer").materialize();
const connector = createMemoryConnector();
const first = createPulse(Doc, { title: "consumer", items: [{ value: 1 }] }, { scope: createPulseScope(), connectors: [connector] });
first.items[0]!.value = 2;
// @ts-expect-error Managed IDs are readonly in the installed declarations.
first.id = "other";
// @ts-expect-error Field types survive the installed declaration graph.
first.title = 42;
const snapshot = snapshotPulse(first);
// @ts-expect-error Detached snapshots have plain arrays, not pulse mutation helpers.
snapshot.items.replaceAll([]);
const message: PulseMessage = { kind: 1, docId: first.id, requestId: 1, vv: [] };
decodeMessage(encodeMessage(message));
await connectPulse(first).synced;
const second = await loadPulse(Doc, first.id, { scope: createPulseScope(), connectors: [connector], waitFor: "all" });
const title: string = second.title;
void title;
destroyPulse(first); destroyPulse(second);
