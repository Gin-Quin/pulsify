import {
  connectPulse, createMemoryConnector, createPulse, createPulseScope, definePulse,
  destroyPulse, loadPulse, snapshotPulse, arrayOperations, exportPulseUpdates, applyPulseUpdates, SUPPORTED_PROTOCOL_VERSIONS, type PulseProperties,
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
const frames: Uint8Array[] = exportPulseUpdates(first, [], {peerVersion:SUPPORTED_PROTOCOL_VERSIONS[1]});
applyPulseUpdates(second,frames);
// @ts-expect-error Unsupported protocol versions are excluded from the public API.
exportPulseUpdates(first,[],{peerVersion:3});
destroyPulse(first); destroyPulse(second);

// The typed codec API and storage entry point also compile from the tarball.
import { object, array, tuple as codecTuple } from "@gin-quin/codec";
import { PostgresPatchStore, type PatchStore } from "@pulsify/core/storage";
const Typed = definePulse("TypedConsumer", object({
  body: "string", origin: object({ name: "string" }), values: array("uint"),
}), { constantPaths: [["origin"]], richTextPaths: [["body"]] }).materialize();
const typed = createPulse(Typed, { body: "Hello", origin: { name: "import" }, values: [] }, { scope: createPulseScope() });
typed.body.insert(5,"!");
typed.values.push(1);
// @ts-expect-error Declared constants remain readonly in installed declarations.
typed.origin.name = "changed";
const typedSnapshot = snapshotPulse(typed);
const text: string = typedSnapshot.body;
void text;
const store: PatchStore = new PostgresPatchStore(async () => []);
void store;
destroyPulse(typed);

const TupleDocument = definePulse("TupleConsumer", object({
  pair: codecTuple("uint", "string"),
  nested: array(object({ values: array("uint") })),
})).materialize();
const tupleDocument = createPulse(TupleDocument, {
  pair: [1, "A"], nested: [{ values: [1, 2] }],
}, { scope: createPulseScope() });
tupleDocument.pair = [2, "B"];
tupleDocument.pair[0] = 3;
tupleDocument.pair[1] = "C";
tupleDocument.nested = [{ values: [] }];
arrayOperations(tupleDocument.pair).replaceAll([4, "D"]);
arrayOperations(tupleDocument.nested).insert(0, [{ values: [5] }]);
// @ts-expect-error Installed declarations preserve individual tuple positions.
tupleDocument.pair[0] = "wrong";
// @ts-expect-error Tuple replacements require the exact declared shape.
arrayOperations(tupleDocument.pair).replaceAll([4, "D", 5]);
const plainTuple: [number, string] = snapshotPulse(tupleDocument).pair;
void plainTuple;
destroyPulse(tupleDocument);
