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
import { createPulse, definePulse, richText, snapshotPulse } from "@pulsify/core";

const schema = object({
  title: "string",
  body: richText(),
  origin: object({ source: "string" }),
  items: array(object({ label: "string", done: "boolean" })),
});
const documentCodec = createCodec(schema);
const Article = definePulse("Article", schema, {
  constantPaths: [["origin"]],
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

`richText()` without an argument declares a string schema with collaborative text
semantics. Codec infers and encodes a plain string; Pulsify infers the public
`RichText` view. It works inside nested objects, arrays, maps, tuples, optional
fields and lazy recursive schemas, without a separate `richTextPaths` annotation:

```ts
const Comment = definePulse("Comment", object({
  body: richText(),
  author: object({ bio: richText() }),
  paragraphs: array(richText()),
})).materialize();
const comment = createPulse(Comment, {
  body: "Hello", author: { bio: "Ada" }, paragraphs: ["First"],
});
comment.author.bio.insert(3, "!");
comment.paragraphs[0]!.format(0, 5, { bold: true });
comment.paragraphs.push(richText("Next"));
```

Schema markers are normalized to codec strings once during compilation; edits
and exports do not resolve the helper again. Existing `richTextPaths` annotations
remain supported. Replacing an annotation with an equivalent inline declaration
preserves codec bytes and schema fingerprints. Inline markers in union branches
apply only to those branches.

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
before its mutation methods can be called. Use `richText("")` for an empty initial
value; `richText()` is reserved for schemas and cannot initialize document data.
Inline schemas and path annotations both accept plain strings as creation input.

## Editor bindings

Declare the same `richText()` field for either editor. Bindings are separate
packages; the core has no ProseMirror, Lexical or React dependency.

```ts
import { bindProseMirror } from "pulsify-prosemirror";
import { bindLexical } from "pulsify-lexical";

// Choose the binding that matches the editor used by this document.
const binding = bindProseMirror(view, note.body);
// Or: const binding = bindLexical(editor, note.body);

binding.destroy();
```

- [ProseMirror API and example](../pulsify-prosemirror/README.md)
- [Lexical API and example](../pulsify-lexical/README.md)

Each document records its editor format. Both bindings use native character
operations and hidden structural anchors, but ProseMirror and Lexical document
models are distinct. An incompatible binding is rejected; custom nodes are not
silently converted. Snapshots remain a plain text projection. Use
`proseMirrorDocument(field, schema)` or `lexicalDocument(field)` for nodes and
formatting, and Pulsify update frames for collaborative history.

For code, syntax highlighting belongs to the editor and the content is plain
text. Plain Pulsify strings are whole-value registers; concurrent character
editing still requires a collaborative text field and an editor binding.

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
import { object } from "@gin-quin/codec";
import { createPulse, definePulse, type PulseProperties } from "@pulsify/core";

const userV1 = object({ name: "string", email: "string" });
const userV2 = object({ name: "string", emailV2: "string" });
type User = PulseProperties<"User"> & { name: string; email: string };

const User = definePulse("User", userV1)
  .migrateTo(userV2, before => ({ emailV2: before.email }))
  .materialize<User>(({ bind }) => ({ email: bind("emailV2") }));

const user = createPulse(User, { name: "Ada", emailV2: "ada@example.com" });
user.email = "grace@example.com";
```

Creation accepts the latest stored shape. Loading applies migrations in order, once per stored version, and synchronizes the resulting patch. A current document does not copy or traverse its view to check for migrations. Migration functions receive a detached copy only when they run, return partial updates, and must be deterministic and free of external side effects; unchanged stored fields remain. They cannot write managed properties. Future migration versions or another document kind are rejected.

Migration inputs are typed as detached data: rich-text fields are strings,
including inside arrays and nested objects. For example, use `before.body` or
`before.body.toUpperCase()`, rather than `before.body.text` or collaborative
editing methods. Schema-based migrations return plain text for rich-text fields;
the target schema supplies the collaborative semantics.

**Never rewrite an applied migration.** Once any client has used a migration,
keep its target schema, transformation and position unchanged. Never go back
and replace a published V1 → V2 migration with a different V1 → V2 migration.
Do not remove or reorder published steps, or change historical schemas and
helpers in ways that alter those steps' behavior. Append new migrations at the
end of the chain to correct previous behavior.

A document already at V2 does not rerun the V1 → V2 callback when its code
changes. Replacing that callback can therefore give different data to two
documents with the same version. Restore the original migration and append a
V2 → V3 correction, even when V3 uses the same schema as V2. If both replacement
variants have already run, the correction must handle their resulting data;
recovering discarded information requires an earlier copy or history.

For schema-based definitions, pass the next schema as the first argument to
`.migrateTo(schema, migrator)`. The callback receives the previous version's
type; the target type is inferred from the supplied schema. New required fields
and fields whose types change must be returned; unchanged fields are preserved:

```ts
import { object } from "@gin-quin/codec";
import { definePulse } from "@pulsify/core";

const personV1 = object({ name: "string" });
const personV2 = object({ name: "string", displayName: "string" });

const Person = definePulse("Person", personV1)
  // V1 → V2: keep this step unchanged once it has been used.
  .migrateTo(personV2, before => ({ displayName: before.name }))
  // V2 → V3: correct existing values in a new step, using the same schema.
  .migrateTo(personV2, before => ({ displayName: before.displayName.trim() }))
  .materialize();
```

An optional third argument supplies `constantPaths` and `richTextPaths` for
the target version, just like the options passed to `definePulse`. Neither a
target type argument nor a subsequent `.schema(...)` call is needed. The existing
`.migrate<Next>(migrator)` method remains available for typed definitions
without runtime schemas and for existing explicit `.schema(...)` chains.

Steps are selected by their position in the version chain, not by a schema
fingerprint. Different migrations may target the same schema, such as normalizing
an existing string field. Use code comments to explain each transformation.
Definitions cache a recursive fingerprint for every version:
`F1 = H(kind, 1, schemaHash1)` and `Fn = H(Fn-1, n, schemaHashN)`. Schema hashes
include codec layouts and constant/rich-text annotations. Changing an earlier
schema changes every later fingerprint, even if the final schema stays the same.
The arrays and lookup map are shared by all documents of a definition; ordinary
edits perform no hashing, schema reconstruction or diagnostic snapshot copying.

Incompatible histories reject the incoming update with `MigrationDriftError`
(`code: "MIGRATION_DRIFT"`) before that update changes the document or journal.
`loadPulse` rejects normally and connection failures reach `onError`. A prominent
uppercase `console.warn` includes the document identity, detected version,
expected/received identities, a detached raw document snapshot, the known local schemas
and local transformation. Application materializer getters are not invoked. A
best-effort incoming root snapshot is explicitly
marked when decoded using a local schema. Unknown remote schemas cannot be
reconstructed from a hash. Identical warnings are deduplicated per pulse instance.
The mismatch may originate before the reported version; restore the published
chain and append a corrective migration instead of forcing an incompatible update.

These fingerprints cover schema history, not callback code: changing only a
transformation with identical schemas is not detectable. Definitions without
runtime schemas cannot detect changes to TypeScript-only data shapes either.
Version 1 keeps its previous wire identity. Versions 2+ use a chain-qualified
identity in the existing patch schema field; old migrated histories without that
identity are not a verified chain and require an explicit application upgrade.
A peer that merely lacks newer versions is reported as incompatible/newer, not
as migration drift. The operation payload and transport envelope versions stay
unchanged; old clients cannot consume the new migrated identities.

The definition retains previous compiled layouts so old operation rows can be
decoded before migration. Fingerprints include schema layout and collaborative
annotations; unknown layouts are incompatible. Definitions with migration
history use string field keys in new patches to preserve old layout identities.

`bind("field")` creates a typed two-way alias. Consumed storage aliases are omitted from enumeration of the public view. Custom derived bindings implement `get(data)` and `set(data, value)`; they do not consume stored fields automatically. Definitions and materializers are local TypeScript functions and are never transmitted to a relay.

## Options and custom transports

`setDefaultPulseOptions` changes defaults; individual calls can override `createId`, `connect`, `connectors`, `scope`, `timeoutMs`, `onError` and an optional numeric `sessionId`. Usually leave session IDs random; explicit IDs must be safe integers >= 65536 and unique among writers of a document.

A `Connector` supplies `kind: "local" | "remote"` and `open({ docId, signal, onMessage, onClose })`, returning a session with asynchronous `send(Uint8Array)` and idempotent `close()`. Deliver complete binary frames, honor cancellation and report transport closure. A WebSocket factory can be supplied to `createWebSocketConnector` for custom runtime/authentication integration. See the [protocol specification](../../docs/PROTOCOL.md).

Durable operation stores are available from `@pulsify/core/storage` for
PostgreSQL and SQLite. They append binary rows and query missing
operations by version vector without loading a document. PostgreSQL's append
is one database call; connect storage to your relay and commit before
acknowledging writes. See the [storage adapter guide](../../docs/STORAGE.md).

The codecs compile trusted, fixed schemas with generated JavaScript functions. Browser deployments need a Content Security Policy that permits that code generation; received frames never supply executable schemas.

## Exact grouped updates

For a peer known to support the current grouped transport:

```ts
import { exportPulseUpdates, applyPulseUpdates } from "@pulsify/core";
const frames = exportPulseUpdates(article, remoteVector, { peerVersion: 2 });
applyPulseUpdates(otherArticle, frames);
```

This is the same exchange implementation used by connectors. Omitting
`peerVersion` keeps envelope 1 for unknown endpoints. Compatible scalar histories
are grouped without dropping any transaction; other histories retain the ordinary
format. Every original operation can still be retrieved by version vector.

The memory connector uses its relay's explicit capability. WebSocket keeps its
legacy handshake by default. Enable the new path only on a known upgraded server
with `createWebSocketConnector(url, undefined, { protocolVersion: 2 })`; it must
select `pulsify-v2`. See [capability negotiation](../../docs/PROTOCOL.md#capability-boundary).

## Hybrid state exchange

For an explicitly supporting peer, `{peerVersion: 3}` condenses long overwritten
scalar runs while keeping ordinary operations for small or structural changes:

```ts
import {
  exportPulseUpdates, applyPulseUpdates, getPulseVersions, recoverPulseHistory,
} from "@pulsify/core";
const frames = exportPulseUpdates(article, remoteVector, { peerVersion: 3 });
applyPulseUpdates(otherArticle, frames);
const { state, history } = getPulseVersions(otherArticle);
// Restore omitted operations before exporting complete history to another store.
await recoverPulseHistory(otherArticle);
```

The server still receives and retains every original operation. A state-only
receiver exposes separate state/history vectors; an exact export through a hole
fails explicitly. `{mode: "history"}` requests exact exports. Recovery requires
a connected source that has the missing rows and verifies that they arrived.
Arrays, rich text, constants and migrations retain their existing operation path.
Current condensation targets typed string/float64 register runs of 32+ writes;
ordinary rows reloaded by the opaque relay use the safe exact fallback.

Memory connections negotiate this automatically. WebSocket stays legacy by
default; use `createWebSocketConnector(url, undefined, {protocolVersion: 3})`
only with an upgraded endpoint that explicitly selects `pulsify-v3`.
See [state delta semantics](../../docs/PROTOCOL.md#optional-state-deltas-envelope-3).
