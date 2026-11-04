# @pulsify/core

A TypeScript API for collaborative object documents, using Pulsify's own LWW
register and RGA engine. The runtime depends on codec and does not import
json-joy or Yjs. Built ESM runs in Bun, Node 22+, Deno 2 and browsers. Build
with `bun run build`; package exports and declarations are in `dist/`. The
declarations support strict NodeNext consumers. Keep shared JavaScript chunks
together with the entry files when copying a build.

## Define, create and observe

```ts
import {
  createPulse, definePulse, subscribePulse, snapshotPulse,
  destroyPulse,
} from "@pulsify/core";
import { array, object } from "@gin-quin/codec";

const Note = definePulse("Note", object({
  title: "string",
  author: object({ name: "string" }),
  tags: array("string"),
})).materialize();
const note = createPulse(Note, {
  title: "Draft", author: { name: "Ada" }, tags: ["work"],
});
const unsubscribe = subscribePulse(note, value => console.log(value.title));
note.title = "Ready";
note.author.name = "Grace";
note.tags.push("review");
const detached = snapshotPulse(note);
unsubscribe();
destroyPulse(note);
```

Subscriptions run immediately, then synchronously after committed changes.
Local creation and edits retain detached native operations without binary
encoding. Sending or exporting history encodes requested patches once and
caches their bytes. `{ connect: true }` starts synchronization after creation;
otherwise encoding waits for a connection or export. The root proxy and
identity registry are always initialized.

Definitions compile application-value checks alongside their codecs. A local
assignment checks the affected schema layout before changing state or history;
incoming operations are checked for compatible values, metadata and causal
references before application. Envelope decoding uses codec directly, without
a second recursive schema walk. Subscriber exceptions are reported through
`onError`; they do not interrupt synchronization. `snapshotPulse` returns
detached enumerable public values, including materialized fields. Without a
custom materializer, it copies the engine view directly rather than traversing
the proxies.

Row-count and metadata capacity limits are checked before local commits. Binary patch and encoded-history size limits are checked when bytes are requested. An oversized local patch can therefore remain usable locally while its export fails with `LIMIT_EXCEEDED`; connection failures are reported through synchronization promises and `onError`.

`id`, `kind`, `version` and `generation` are managed by Pulsify. Supply `id`
only at creation. The supported generation is zero. Values include finite
numbers, bigint, well-formed Unicode strings, booleans, null, undefined, dense arrays,
plain objects and copied `Uint8Array` leaves. Schemas describe that supported
value vocabulary; arbitrary class instances, cycles and reserved prototype
properties (`__proto__`, `constructor`, `prototype`) are rejected. Float32
fields use their normalized wire value on the originating replica too.

Object fields are inline LWW registers; containers and sequence entries have
stable IDs. Plain strings are atomic values. Replacing a string assigns its
whole register; use an explicit rich-text field for character operations.

Nested views retain identity while their CRDT node exists, including across remote edits. References to replaced or removed nodes become invalid; read the replacement from its parent. Array removal methods return detached values. Array holes, extending `length` and deleting an array index are rejected; use `splice`. Reordering/replacing a collection rebuilds its elements and can invalidate previous element references.

Arrays use ordinary TypeScript array types, so assigning a plain array or an
object containing arrays works naturally. Use
`arrayOperations(pulse.items).insert(start, items)`, `.delete(start, count)`, or
`.replaceAll(items)` for additional collection helpers. Import `arrayOperations`
from `@pulsify/core`. Codec tuples retain their positional types and literal
length; `arrayOperations(pulse.pair).replaceAll([value0, value1])` checks the
complete tuple shape. Operations that change tuple cardinality reject at
runtime, including native `push` and `pop`. Snapshots contain plain arrays and
tuples without helper members.

## Codec schemas, constants and rich text

Use the same schema instance with codec and Pulsify. The schema describes
application fields; Pulsify supplies `id`, `kind`, `version` and `generation`.

```ts
import { array, createCodec, object } from "@gin-quin/codec";
import { createPulse, definePulse, snapshotPulse } from "@pulsify/core";

const schema = object({
  title: "string",
  body: "string",
  origin: object({ source: "string" }),
  items: array(object({ label: "string", done: "boolean" })),
});
const documentCodec = createCodec(schema);
const Article = definePulse("Article", schema, {
  constantPaths: [["origin"]],
  richTextPaths: [["body"]],
}).materialize();

const article = createPulse(Article, {
  title: "Draft",
  body: "Hello",
  origin: { source: "import" },
  items: [],
});
article.title = "Ready";
article.body.insert(5, " world");
article.body.format(0, 5, { bold: true });
console.log(article.body.toDelta());
// [{ insert: "Hello", attributes: { bold: true } }, { insert: " world" }]

const snapshot = snapshotPulse(article);
// snapshot.body is the plain string "Hello world".
// Pass the application fields to documentCodec; managed fields are separate.
documentCodec.encode({
  title: snapshot.title, body: snapshot.body,
  origin: snapshot.origin, items: snapshot.items,
});
```

The definition compiles object field slots, field codecs, accessors, value checks
and detached copies once. Mutation patches can refer to numeric field slots and
use the field's compiled codec instead of repeating property names and types.
`definePulse("Article").schema(schema, options)` is equivalent; the existing
`definePulse<Data>("Article")` API remains available without a runtime schema.

Constant fields and their descendants are readonly in TypeScript and reject
replacement, deletion and nested edits at runtime. Codec `literal(value)` fields
are also constant. `*` in an annotation path applies to each array element or map
value, for example `["items", "*", "id"]`. Annotations are separate from the
codec schema, so they do not change its encoded document bytes. A field cannot
be both constant and collaborative rich text.

Constants retain their captured values for their lifetime. A migration cannot
change an existing constant or remove its constant annotation while keeping
that path in the schema. A migration may turn a mutable value into a constant;
the resulting patch captures its value so late edits to the old child cannot
change it. Binary leaves are returned as detached copies.

The legacy `struct({...})` and `tuple([...])` helpers make the initialized
value's contents immutable. Without a schema constant annotation, their parent
field can still be assigned another value. Use `constantPaths` when the field
itself must also remain bound to its initial value.

Rich text exposes `text`, `length`, `insert`, `delete`, `format`, and `toDelta`.
Indices count Unicode code points. Formatting uses per-character attributes;
concurrent edits of different attributes merge, and conflicting writes to one
attribute use the engine's deterministic last-writer order. `null` or `undefined`
removes an attribute. Insertion accepts optional attributes as its third
argument and does not inherit adjacent formatting. Snapshots and JSON output
contain the plain text; use `toDelta()` to read formatting. Text and attribute
operations remain in collaborative history and survive synchronization.

For a definition without a runtime schema, declare a `RichText` field and
initialize it with `richText("Hello")`. The marker must be attached to a pulse
before its mutation methods can be called. Schema annotations also accept a
plain string as the creation input.

## Connect and load

```ts
import {
  connectPulse, createWebSocketConnector, loadPulse, disconnectPulse,
} from "@pulsify/core";

const connector = createWebSocketConnector("ws://localhost:3000/sync");
const remoteNote = await loadPulse(Note, "document-id", {
  connectors: [connector],
  waitFor: "all",
  timeoutMs: 10_000,
});
disconnectPulse(remoteNote);  // Keep editing locally.
remoteNote.tags.push("offline");
await connectPulse(remoteNote).synced;
```

Creation starts disconnected by default. Pass `{ connectors: [connector], connect: true }` to start automatically, or call `connectPulse(note)`. Its promises resolve to the same public pulse:

| Promise | Meaning |
| --- | --- |
| `ready` | Usable document data is available. Configured local connectors are tried before remote connectors. |
| `connected` | All configured connectors have completed their initial download. |
| `synced` | Initial synchronization is complete and all configured connectors have acknowledged the local history. |

`loadPulse` waits for `ready` by default. `waitFor` accepts `"connected"`, `"synced"`, `"all"` (alias of `"synced"`) or an array of configured connectors. Required connector failures reject `connected`/`synced`; an earlier `ready` may already have succeeded. Missing documents, aborts and timeouts settle with a `PulseError`. Pass `signal` to cancel initial loading. With no connectors, a created document resolves immediately and loading an unknown ID rejects with `NOT_FOUND`.

These promises describe initial synchronization; future edits continue flowing through the sessions. Use `getPulseMeta(pulse)` for diagnostic status and the last connection error. Its engine/journal fields are internal state: do not mutate them directly. After an established transport closes, call `disconnectPulse` and `connectPulse` to reconnect; retries are application-controlled.

## Client scopes and in-memory synchronization

One scope contains one public instance per document ID and definition. Reusing an ID returns the existing materialized instance. Use separate scopes for different clients, tests, requests or tenants.

```ts
import {
  createMemoryConnector, createPulseScope, PulseRelay,
} from "@pulsify/core";

const relay = new PulseRelay();
const connector = createMemoryConnector(relay);
const first = createPulse(Note, {
  id: "shared", title: "Draft", author: { name: "Ada" }, tags: [],
}, { scope: createPulseScope(), connectors: [connector] });
await connectPulse(first).synced;
const second = await loadPulse(Note, "shared", {
  scope: createPulseScope(), connectors: [connector], waitFor: "all",
});
first.author.name = "Grace"; // Automatically reaches second.
```

`createMemoryConnector()` creates a private relay when none is supplied. For a shared relay that validates inner CRDT operations too, use the default connector relay or supply an operation validator to `PulseRelay`; the generic protocol relay otherwise treats operation bytes as opaque.

`destroyPulse` closes sessions, cancels unfinished initialization, removes subscriptions and releases the identity-map entry. Writes to destroyed instances fail. Destroying a client does not delete the relay's stored history.

## Migrations and materialization

```ts
import { createPulse, definePulse, type PulseProperties } from "@pulsify/core";

type UserV1 = PulseProperties<"User"> & { name: string; email: string };
type UserV2 = PulseProperties<"User"> & { name: string; emailV2: string };
type User = UserV1;

const User = definePulse<UserV1>("User")
  .migrate<UserV2>("v2", before => ({ emailV2: before.email }))
  .materialize<User>(({ bind }) => ({ email: bind("emailV2") }));

const user = createPulse(User, { name: "Ada", emailV2: "ada@example.com" });
user.email = "grace@example.com";
```

Creation accepts the latest stored shape. Loading applies migrations in order, once per stored version, and synchronizes the resulting patch. A current document does not copy or traverse its view to check for migrations. Migration functions receive a detached copy only when they run, return partial updates, and must be deterministic and free of external side effects; unchanged stored fields remain. They cannot write managed properties. Future migration versions or another document kind are rejected.

For schema-based definitions, register the schema for each stored version
before defining its next migration. Select the new schema with `.schema(...)`
after that migration:

```ts
import { object, type InferType } from "@gin-quin/codec";
import { definePulse, type PulseProperties } from "@pulsify/core";

const personV1 = object({ name: "string" });
const personV2 = object({ name: "string", displayName: "string" });
type PersonV2 = PulseProperties<"Person"> & InferType<typeof personV2>;

const Person = definePulse("Person", personV1)
  .migrate<PersonV2>("display-name", before => ({ displayName: before.name }))
  .schema(personV2)
  .materialize();
```

The definition retains previous compiled layouts so old operation rows can be
decoded before migration. Fingerprints include schema layout and collaborative
annotations; unknown layouts are incompatible. Definitions with migration
history use string field keys in new patches to preserve old layout identities.

`bind("field")` creates a typed two-way alias. Consumed storage aliases are omitted from enumeration of the public view. Custom derived bindings implement `get(data)` and `set(data, value)`; they do not consume stored fields automatically. Definitions and materializers are local TypeScript functions and are never transmitted to a relay.

## Options and custom transports

`setDefaultPulseOptions` changes defaults; individual calls can override `createId`, `connect`, `connectors`, `scope`, `timeoutMs`, `onError` and an optional numeric `sessionId`. Usually leave session IDs random; explicit IDs must be safe integers >= 65536 and unique among writers of a document.

A `Connector` supplies `kind: "local" | "remote"` and `open({ docId, signal, onMessage, onClose })`, returning a session with asynchronous `send(Uint8Array)` and idempotent `close()`. Deliver complete binary frames, honor cancellation and report transport closure. A WebSocket factory can be supplied to `createWebSocketConnector` for custom runtime/authentication integration. See the [protocol specification](../../docs/PROTOCOL.md).

Durable operation stores are available from `@pulsify/core/storage` for
PostgreSQL, SQLite and FoundationDB. They append binary rows and query missing
operations by version vector without loading a document. PostgreSQL's append
is one database call; connect storage to your relay and commit before
acknowledging writes. See the [storage adapter guide](../../docs/STORAGE.md).

The codecs compile trusted, fixed schemas with generated JavaScript functions. Browser deployments need a Content Security Policy that permits that code generation; received frames never supply executable schemas.
