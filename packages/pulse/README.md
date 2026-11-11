# @pulsify/core

A TypeScript API for collaborative object documents, using Pulsify's own LWW
register and RGA engine. The runtime depends on codec and does not import
json-joy or Yjs. Built ESM runs in Bun, Node 22+, Deno 2, browsers and Cloudflare Workers. Build
with `bun run build`; package exports and declarations are in `dist/`. The
declarations support strict NodeNext consumers. Keep shared JavaScript chunks
together with the entry files when copying a build.

## Define, create and observe

```ts
import {
  createPulse, definePulse, subscribePulse, snapshotPulse,
  destroyPulse, array, object,
} from "@pulsify/core";

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

Nested views retain identity while their CRDT node exists, including across remote edits. References to replaced or removed nodes become invalid; read the replacement from its parent. Array removal methods return detached values. Array holes, extending `length` and deleting an array index are rejected; use `splice`. `sort`, `reverse` and `replaceAll` rebuild elements and can invalidate previous references. Explicit moves preserve references and concurrent edits.

Arrays use ordinary TypeScript array types, so assigning a plain array or an
object containing arrays works naturally. Use
`arrayOperations(pulse.items).insert(start, items)`, `.delete(start, count)`, or
`.replaceAll(items)` for additional collection helpers. Import `arrayOperations`
from `@pulsify/core`. Codec tuples retain their positional types and literal
length; `arrayOperations(pulse.pair).replaceAll([value0, value1])` checks the
complete tuple shape. Operations that change tuple cardinality reject at
runtime, including native `push` and `pop`. Snapshots contain plain arrays and
tuples without helper members.

## Array moves

```ts
import { arrayOperations } from "@pulsify/core";

// [A, B, C, D] -> [A, C, D, B]
arrayOperations(doc.items).move(1, 3);
// Move a contiguous block; `to` is its first index in the final array.
arrayOperations(doc.items).move(0, 2, 2);
```

Indices and count must be nonnegative safe integers; the source block and final
destination must fit. Count defaults to one. Empty moves and unchanged positions
are no-ops. Tuples cannot move because their slots have different types.

A move creates RGA position tokens referencing the original elements. Their
objects, nested arrays and rich text keep their identity. Concurrent moves of
the same element choose one position by the existing LWW order (Lamport time,
actor ID, then actor clock); a later observed move wins. Concurrent value edits
still target the original element. Deletion wins over every move of that element.
Block moves are one operation, but each element resolves competing moves
independently: a concurrent overlapping move can split the block.

Insertions address a specific position token. If a peer inserts after an older
position while offline, that insertion stays at the old position when the
element moves; it does not follow the moved element. Tokens remain as anchors
even when their element is deleted or another move wins. Concurrent moves of
different elements use the deterministic RGA order, which can differ from either
peer's isolated result. These rules hold regardless of delivery order or duplicates.

## Generic ordered trees

```ts
import { createCodec, createPulse, definePulse, object, richText, tree } from "@pulsify/core";

const outlineSchema = tree(object({ title: "string", body: richText() }));
const Outline = definePulse("Outline", object({ outline: outlineSchema })).materialize();
const doc = createPulse(Outline, { outline: {} });
const chapter = doc.outline.createNode({ title: "Chapter", body: "Hello" });
const section = chapter.createNode({ title: "Section", body: "Text" });
const appendix = doc.outline.createNode({ title: "Appendix", body: "" });

section.move(appendix, 0);
section.data.body.insert(4, "!");
section.move();                 // Append as a root.
section.moveBefore(chapter);    // Also adopts the sibling's parent.
section.moveAfter(appendix);
const roots = doc.outline.roots();
const children = chapter.children();
const sameNode = doc.outline.getNode(section.id);
const hierarchy = doc.outline.toJSON();
const stored = doc.outline.snapshot();
createCodec(outlineSchema).encode(stored);
```

`tree(elementSchema)` is a generic codec-compatible schema, including primitive,
object, array, rich-text and nested-tree payloads. `Tree<T>` exposes node methods;
each node's `data` is a normal typed collaborative value. `createNode(data,
parent?, index?)` and `parent.createNode(data, index?)` accept initial values,
including strings for rich text and `{}` for nested trees. Indices refer to the
final sibling list, after removing the moved node. Omitting index appends.
`nodes()` returns visible nodes without a traversal-order guarantee; `parent()`,
`children()` and `index()` describe the projected hierarchy. Cross-tree moves,
invalid indices and local moves into a node's own subtree throw before committing.
Tree containers cannot be annotated constant; their payloads may contain constants.

Storage is a flat ID map. Each record contains `data`, an atomic `location`
(`parent`, `position`) register and a permanent `deleted` flag. Empty parent means
root. `snapshotPulse` and `tree.snapshot()` return this detached codec format,
including tombstones and raw parent links. `toJSON()` returns the visible ordered
hierarchy as `{ id, data, children }[]`, with detached payload snapshots. Initialize
with `{}` or a previous snapshot; position keys are engine metadata and should
be preserved rather than edited manually.

Reparenting preserves the node, its entire subtree and payload proxies. Parent and
position resolve together by LWW, so concurrent edits to payloads survive moves.
Sibling order uses dense fractional keys with actor/clock suffixes, so concurrent
insertions at the same index remain independently addressable and can be followed
by another insertion between them.

Concurrent individually valid moves can form a cycle. The view deterministically
cuts the parent edge of the lexicographically smallest node ID in each cycle,
making that node a root. Raw location registers remain intact; later moves
recompute the projection. Explicitly moving that projected root to roots clears
its raw parent even when the view already shows it as a root. This is a
cycle-breaking LWW projection, rather than an implementation of Loro's tree
algorithm; a conflict can introduce a root that neither peer explicitly requested.

`node.delete()` permanently hides that node. Descendants whose resolved ancestry
passes through it are hidden too, including concurrent insertions or moves into
the deleted subtree. An offline move of a descendant out of that subtree survives
if its winning location has no deleted ancestor. Moving the deleted node itself
cannot restore it. Retained node handles and mutable payload proxies reject use while their
node is hidden or deleted. A whole-tree field replacement creates a new container.

## Automatic connector batching

Connector batching is automatic and was already implemented. Local writes commit
immediately, and each connection schedules a sync using standard `queueMicrotask`:

```ts
doc.object.x = 12;
doc.array.push(13);
// One scheduled upload per connection contains both changes.
```

Each write retains its own causal history row. This is transport batching, not a
public rollback transaction: local subscribers can observe each intermediate
state, and a failed later write leaves earlier writes committed. Writes after an
`await` may start another batch. Large batches split at protocol limits, and
separate documents or connectors have separate uploads. `connection.syncBack()`
explicitly waits for an upload and acknowledgement.

The scheduler works in browsers, Node, Bun and Workers. On Cloudflare Workers,
materialize schema definitions at module startup: Codec and Pulsify compile
functions then, while request handling reuses them. Use a compatibility date of
2025-06-01 or later (or `allow_eval_during_startup` on older dates). Await the
connection's `syncBack()` before returning a response, or attach that promise to
`ctx.waitUntil()`, when delivery must outlive the request. `bun run test:workers`
checks batching, tree/array moves and offline merges in workerd with Node
compatibility disabled.

## Codec schemas, constants and rich text

Use the same schema instance with codec and Pulsify. The schema describes
application fields; Pulsify supplies `id`, `kind`, `version` and `generation`.

```ts
import {
  array, constant, createCodec, createPulse, definePulse, frozen, object,
  richText, snapshotPulse, tuple,
} from "@pulsify/core";

const schema = object({
  title: "string",
  body: richText(),
  origin: constant(object({ source: "string" })),
  cover: frozen(tuple("uint", "uint")),
  items: array(object({ label: "string", done: "boolean" })),
});
const documentCodec = createCodec(schema);
const Article = definePulse("Article", schema).materialize();

const article = createPulse(Article, {
  title: "Draft",
  body: "Hello",
  origin: { source: "import" },
  cover: [640, 480],
  items: [],
});
article.title = "Ready";
article.cover = [800, 600]; // replaced as a whole; article.cover[0] = 1 is rejected
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

Wrap a schema in `constant(...)` for a value fixed at creation: the field and
its descendants are readonly in TypeScript and reject replacement, deletion and
nested edits at runtime. Codec `literal(value)` fields are also constant. Wrap a
schema in `frozen(...)` for a value that is only replaced as a whole: the field
accepts a new value, but its contents are deeply readonly and reject nested
edits. A frozen value is stored and synchronized as one unit, so concurrent
replacements never interleave its contents. `frozen` requires a structured
schema (object, array, map, set, tuple, union or `"unknown"`).

Both markers are separate from the codec schema, so they do not change its
encoded document bytes. Neither can contain collaborative rich text or trees.
The deprecated `constantPaths` option still marks constants by path; `*` applies
to each array element or map value, for example `["items", "*", "id"]`.

Constants retain their captured values for their lifetime. A migration cannot
change an existing constant or remove its constant annotation while keeping
that path in the schema. A migration may turn a mutable value into a constant;
the resulting patch captures its value so late edits to the old child cannot
change it. The same rules apply to frozen contents: a migration may freeze a
field, but not unfreeze it. Binary leaves are returned as detached copies.

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
// Connected until disconnectPulse: lost connections are retried automatically.
disconnectPulse(remoteNote);  // Stop on purpose; edits continue locally.
remoteNote.tags.push("offline");
await connectPulse(remoteNote).synced;
```

Creation starts disconnected by default. Pass `{ connectors: [connector], connect: true }` to start automatically, or call `connectPulse(note)`. Its promises resolve to the same public pulse:

| Promise | Meaning |
| --- | --- |
| `ready` | Usable document data is available. Configured local connectors are tried before remote connectors. |
| `connected` | All configured connectors have completed their initial download. |
| `synced` | Initial synchronization is complete and all configured connectors have acknowledged the local history. |

`loadPulse` waits for `ready` by default. `waitFor` accepts `"connected"`, `"synced"`, `"all"` (alias of `"synced"`) or an array of configured connectors. Missing documents, non-retryable errors, aborts and `timeoutMs` settle the promises with a `PulseError`; an earlier `ready` may already have succeeded. Pass `signal` to cancel initial loading. With no connectors, a created document resolves immediately and loading an unknown ID rejects with `NOT_FOUND`.

### Reconnection

`connectPulse` means "stay synchronized with every connector, local or remote, until `disconnectPulse` or `destroyPulse`". Each connector has its own lifecycle:

- A closed transport, a failed opening or a request without an answer within `timeoutMs` (`CLOSED`, `CONNECTION_FAILED`, `TIMEOUT`, see `isRetryable`) puts the connection in `reconnecting`. It retries after `initialDelayMs × factor^n`, capped at `maxDelayMs` and shortened by up to `jitter` at random (`reconnect` option, defaults 250 ms, ×2, 30 s, 0.25; `false` gives up after one failure).
- Every new session is a complete synchronization: the connector's state is considered unknown, so the session sends the local version vector, downloads what is missing and uploads everything the connector has not acknowledged.
- `FORBIDDEN`, incompatible documents, invalid frames and exceptions thrown while applying received data (for example by a migration) stop that connector with status `error`. A connector can mark any error with `new PulseError(code, message, { retryable })`.
- Lazy waking: when a pulse has rows to upload (a local edit) while a connector is down, that connector retries within a second instead of waiting for the full backoff, and at most once a second while it stays down. Passive documents keep their backoff.
- `onError` receives one report per outage, not one per attempt. Connections emit `reconnecting(error, delayMs, attempt)`, and expose `status`, `attempt` and `lastError`.
- The browser's `online` event and `setOnlineMode(true)` retry waiting connections at once and probe established ones; while `navigator.onLine` is false or `setOnlineMode(false)` is set, attempts wait. Between those events, connectors detect transports that died without closing, once per socket (the cloud connector pings idle sockets); a connector reports it with `onClose(error)`.
- `timeoutMs` bounds the promises, not the intent: after a `TIMEOUT` the connectors keep trying. Calling `connectPulse` again after a settled attempt returns new promises and retries failing or stopped connectors at once.

`getPulseMeta(pulse).status` is `idle`, `syncing`, `ready`, `synced`, `offline` (a connector is being retried) or `error`; `subscribePulseStatus(pulse, (status) => …)` reports it now and on every change. Its engine/journal fields are internal state: do not mutate them directly.

## Sub-pulses

A pulse can hold the IDs of child pulses. A child is a separate document with
its own history and version vector, so it loads and synchronizes on its own;
its ID is prefixed by the parent ID, which lets a server co-locate a whole tree.

```ts
import { array, createPulse, definePulse, loadPulse, object, sub, subPulse } from "@pulsify/core";

const Document = definePulse("Document", object({ title: "string" })).materialize();
const Project = definePulse("Project", object({
  name: "string", documents: array(sub(Document)),
})).materialize();
const User = definePulse("User", object({
  name: "string", projects: array(sub(Project)),
})).materialize();

const user = createPulse(User, { id: "1234", name: "Ada", projects: [] });
const project = createPulse(Project, { name: "Engine", documents: [] }, { parent: user });
project.id;                      // "1234/<generated>"
user.projects.push(subPulse(project));

const handle = user.projects[0]!; // SubPulse<typeof Project>
handle.id;                        // The stored value
handle.pulse;                     // Pulse<Project> | undefined: loaded in this scope?
await handle.load();              // loadPulse with the parent's scope and connectors

await loadPulse(User, "1234", { connectors, include: true });
await loadPulse(User, "1234", { connectors, include: { projects: { documents: true } } });
await loadPulse(Project, "1234/xyz", { connectors }); // A child without its parent
```

`sub(Definition)` is a string field on the wire; snapshots and migrations see the
ID. Reads return a handle; writes accept a handle, a pulse or an ID string at
runtime, and `subPulse(pulse)` produces the typed handle. `{ parent }` prefixes
the generated ID, rejects an explicit ID outside the parent, and inherits the
parent's scope, connectors and other options. `include: true` loads every
sub-pulse recursively; an object selects fields, where `true` loads that child
only and a nested object continues into it. Arrays, maps and optionals are
transparent. Included loads use the same `waitFor`, and a missing child rejects
the whole load with `NOT_FOUND`. Creating a child and linking it from its parent
are two documents and two writes; a dangling ID is tolerated and resolves to
`pulse === undefined` until the child exists.

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
import { createPulse, definePulse, object, type PulseProperties } from "@pulsify/core";

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
import { definePulse, object } from "@pulsify/core";

const personV1 = object({ name: "string" });
const personV2 = object({ name: "string", displayName: "string" });

const Person = definePulse("Person", personV1)
  // V1 → V2: keep this step unchanged once it has been used.
  .migrateTo(personV2, before => ({ displayName: before.name }))
  // V2 → V3: correct existing values in a new step, using the same schema.
  .migrateTo(personV2, before => ({ displayName: before.displayName.trim() }))
  .materialize();
```

An optional third argument supplies `richTextPaths` (and the deprecated `constantPaths`) for
the target version, just like the options passed to `definePulse`. Neither a
target type argument nor a subsequent `.schema(...)` call is needed. The existing
`.migrate<Next>(migrator)` method remains available for typed definitions
without runtime schemas and for existing explicit `.schema(...)` chains.

Steps are selected by their position in the version chain, not by a schema
fingerprint. Different migrations may target the same schema, such as normalizing
an existing string field. Use code comments to explain each transformation.
Definitions cache a recursive fingerprint for every version:
`F1 = H(kind, 1, schemaHash1)` and `Fn = H(Fn-1, n, schemaHashN)`. Schema hashes
include codec layouts and constant/frozen/rich-text annotations. Changing an earlier
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

A `Connector` supplies `kind: "local" | "remote"` and `open({ docId, signal, onMessage, onClose })`, returning a session with asynchronous `send(Uint8Array)` and idempotent `close()`. Deliver complete binary frames, honor cancellation and report transport closure. A WebSocket factory can be supplied to `createWebSocketConnector` for custom runtime/authentication integration, and a `{docId}` placeholder in its URL is replaced per session for servers that route before the first frame. See the [protocol specification](../../docs/PROTOCOL.md).

Authorization is a server decision taken at the session boundary, outside the replicated data. `PulseRelay.open(send, { readOnly: true, docId })` serves connect and sync and answers any upload with `FORBIDDEN`; `docId` pins the session to one document before its connect frame. `relayStoreMessage(store, frame, session)` serves one frame directly from a `PatchStore` without an in-memory journal, committing rows before the acknowledgement and returning the frames to send back plus the rows to `encodeBroadcast` to the document's other peers. `@pulsify/cloud-server` builds a managed backend on these pieces: one actor per root pulse (a Cloudflare Durable Object or an actor of the Unikraft Cloud server), one multiplexed WebSocket per user and root, and reader/editor/owner grants stored in each root.

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
