# pulsify-core

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
} from "pulsify-core";

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
only at creation. `generation` starts at zero and grows by one each time the
document is [restored](#restoring). Values include finite
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
from `pulsify-core`. Codec tuples retain their positional types and literal
length; `arrayOperations(pulse.pair).replaceAll([value0, value1])` checks the
complete tuple shape. Operations that change tuple cardinality reject at
runtime, including native `push` and `pop`. Snapshots contain plain arrays and
tuples without helper members.

## Array moves

```ts
import { arrayOperations } from "pulsify-core";

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
import { createCodec, createPulse, definePulse, object, richText, tree } from "pulsify-core";

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

Each write is its own transaction. This is transport batching, not a
public rollback transaction: local subscribers can observe each intermediate
state, and a failed later write leaves earlier writes committed. Writes after an
`await` may start another batch. Large batches split at protocol limits, and
separate documents or connectors have separate uploads. `connection.syncBack()`
resolves once the connector acknowledged every row written before the call.
While an acknowledgement is pending, later writes and calls share one
follow-up upload instead of queueing one each. `connection.whenSynced` also
resolves on the frontier at the read, and waits through outages;
`connection.waitSynced(signal)` is the same wait, dropped on `signal`.

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
} from "pulsify-core";

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
schema (object, array, record, set, tuple, union or `"unknown"`). A
`map(key, value)` can be neither constant nor frozen; use a record there.

Both markers are separate from the codec schema, so they do not change its
encoded document bytes. Neither can contain collaborative rich text or trees.
The deprecated `constantPaths` option still marks constants by path; `*` applies
to each array element or record value, for example `["items", "*", "id"]`.

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

## Records and maps

`record(value)` is a plain object with any string keys and one value schema.
`map(key, value)` is a JavaScript `Map`, for keys that are not only strings:

```ts
import { createPulse, definePulse, map, object, record } from "pulsify-core";

const Sheet = definePulse("Sheet", object({
  prefs: record("boolean"),                            // Record<string, boolean>
  rows: map("int", "string"),                          // Map<number, string>
  prices: map("float64", object({ label: "string" })), // Map<number, { label: string }>
})).materialize();

const sheet = createPulse(Sheet, {
  prefs: {},
  rows: new Map([[1, "first"]]),
  prices: new Map(),
});
sheet.prefs["dark"] = true;
sheet.rows.set(-2, "before");
sheet.prices.set(0.5, { label: "half" });
sheet.prices.get(0.5)!.label = "one half"; // edits the entry in place
sheet.rows.delete(1);
[...sheet.rows.keys()]; // [-2]
```

A key schema is `"string"`, any integer type, `"float64"`, `"boolean"` or
`bigint()`: the types a `Map` compares by value. Each key is one last-writer-wins
register, exactly like a record key, and a value can be any schema, including
`counter()`, `plainText()` or another map. The view is a `Map` (`instanceof Map`
holds) whose methods read and write the pulse.

- Entries iterate in ascending key order, not insertion order. Peers receive
  entries in different orders; a sorted map reads the same on all of them.
- `set` rejects a key of another type, and `get`, `has` and `delete` treat it as
  absent. `-0` and `0` are one key. `NaN` and infinities are not keys.
- Snapshots and migrations see a detached `Map`. JSON output holds the entries,
  `[[key, value], …]`, which `new Map(json)` reads back.
- Assigning a `Map` replaces the whole container, like assigning an object.
- A map cannot be the root of a pulse, nor `constant` or `frozen`.
- Where no schema declares it (an `"unknown"` field), a `Map` is stored as a
  record keyed by the string of each key.

Before version 13, `map(value)` was what `record(value)` is now. Renaming the
call is the whole migration: a record keeps its bytes and its schema identity.

## Plain text

A `"string"` field is replaced as a whole: when two peers edit it at the same
time, one value wins. Declare `plainText()` for a string whose concurrent edits
merge, such as a text area or a code editor. It is a sequence of characters
without formatting, and needs a runtime schema.

```ts
import { createPulse, definePulse, object, plainText } from "pulsify-core";

const Note = definePulse("Note", object({
  title: "string",   // atomic: the last writer wins
  body: plainText(), // collaborative: edits merge
})).materialize();
const note = createPulse(Note, { title: "Note", body: "Hello" });

note.body.insert(5, " world");
note.body.replace(0, 5, "Goodbye"); // delete 5 code units, insert, as one edit
note.body.delete(0, 3);
console.log(note.body.text, note.body.length);

// Assigning edits only what changed, so a text area needs no binding:
textarea.addEventListener("input", () => {
  note.body = plainText(textarea.value);
});
```

Plain text exposes `text`, `length`, `insert`, `delete`, `replace`, `anchorAt`
and `indexOf`. Indices and lengths count UTF-16 code units, like `String`,
`selectionStart` and CodeMirror positions. A character outside the Basic
Multilingual Plane, such as an emoji, is stored as one entry, so concurrent
edits never split it; an index between its two code units is rejected. A count
past the end deletes up to the end.

Assigning a string or `plainText(string)` to an existing field compares it with
the current text, trims the common prefix and suffix, and edits the remainder.
Edits made elsewhere in the text by other peers survive, the field keeps its
view and its anchors, and an unchanged string writes nothing. The same holds
for an array element or a record or map value. Assigning to an absent optional field
creates the text. `plainText(string)` exists for TypeScript, which gives the
field one type for reads and writes; an untyped assignment of a string does the
same. Outside a declared field, a plain text value is an ordinary string.

`anchorAt(index)` returns a string that follows its character through every
local and remote edit, and `indexOf(anchor)` its current index: store a caret
that way to keep it in place while other peers type. Snapshots and JSON output
contain the string. Plain text cannot be `constant()` or `frozen()`. Use
`richText()` instead when the text carries formatting or editor structure.

## Counters

A number field is replaced as a whole: when two peers add one at the same
time, both write the same value and one click is lost. Declare `counter()` for
a number that every peer changes, such as a like button, a vote or a stock.

```ts
import { counter, createPulse, definePulse, object } from "pulsify-core";

const Post = definePulse("Post", object({
  title: "string",
  likes: counter(),
})).materialize();
const post = createPulse(Post, { title: "Hello", likes: 0 });

button.addEventListener("click", () => post.likes.increment());
post.likes.increment(5); // any positive integer
post.likes.decrement();  // -1
post.likes.set(10);      // adds what is missing to reach 10
post.likes.value;        // the total, on every peer
```

A counter stores one count per [actor ID](#actor-ids). A replica changes only
its own count, and the value is the sum of all counts, so changes made at the
same time or offline all add up. A count can be negative, and so can the value.

`set(value)` adds the difference between `value` and the value this replica
sees to its own count: it is an increment or a decrement of that difference,
not a write that wins over the others. An increment made elsewhere at the same
time is kept on top of it, and two peers setting the same value at the same
time both add their difference. From 10, two concurrent `set(0)` give -10.

Snapshots, JSON output, codec and migrations see the total as a `"float64"`
that only holds integers. A
counter also converts to a number: `+post.likes`, `` `${post.likes}` ``.
Creation takes its initial value. Where a counter does not exist yet (an
optional field, a record value, an array element), assign `counter(initial)`:

```ts
post.reactions["👍"] ??= counter(0);
post.reactions["👍"].increment();
```

Two peers that create the same record key at the same time create two counters,
and the key keeps one of them: the changes made to the other are dropped.
Declare a field, or create the keys with their parent, when that matters.

Assigning to an existing counter is its `set`, so the counter and the changes
other peers make to it are kept: `post.likes = counter(0)`. Deleting an
optional field or a record key, then assigning it again, creates a new counter.
A migration from a number field holding an integer to `counter()` keeps its
value. A counter cannot be `constant()` or `frozen()`.

Reading a counter and changing it cost the same as a number field, whatever
the number of actors. Like a field, a counter keeps [no history](#history):
a document stores one count per actor, however often it changes.
`versioned(counter())` keeps every change instead.

## History

A field keeps its last value only. Writing it again replaces the previous
write in every journal and every store, so a document's history, and the
database behind it, grow with the size of the document and not with the
number of edits. Wrap a schema in `versioned()` to keep every write instead:

```ts
import { counter, definePulse, object, versioned } from "pulsify-core";

const Invoice = definePulse("Invoice", object({
  title: "string",                                   // last value only
  status: versioned("string"),                       // every write is kept
  total: versioned("float64", { timestamps: true }), // and the time of each write
  views: counter(),                                  // last count per actor
  edits: versioned(counter()),                       // every change
})).materialize();

// A whole document, or any object inside one:
const Audited = definePulse("Audited", versioned(object({ title: "string" })));
```

- **What keeps its last value only.** A field of an object, an entry of a
  record or a map, and a count, when the value written is a number, a
  string, a boolean, `null`, bytes or a `frozen()` value. Deleting such a
  field is a write like another.
- **What always keeps its history.** Text and array edits, array moves and
  trees, where every edit is part of the result. Replacing an array or a
  tuple element. And an assignment that creates an object, an array, a text
  or a counter: other peers may already be editing what it created.
- **`versioned(schema)`** applies to the value and to everything inside it.
- **`timestamps`** records the writer's clock (`Date.now()`) with each write.
  It is the time of the edit, kept offline too, and it is not verified: a
  client can send any time. On a whole document, every transaction has a
  time: its creation, text and array edits and migrations too.
- **What a store holds.** One row per field and per peer that wrote it: each
  peer's last write. A store overwrites it in place, at the cost of a row
  that keeps its history.
- **Nothing changes in what peers see.** The same write wins on every
  replica. A replica that connects late receives the writes that still
  matter instead of all of them.
- **Changing the mode** is a schema change, made by a migration step:
  `.migrateTo(nextSchema, () => ({}))`. The value stays as it is. Turned on,
  history starts at that version; turned off, it stops and the rows already
  stored stay.

A document created before version 13 keeps the history it has, and its
fields stop adding to it. To keep the previous behaviour, add a version that
wraps the schema in `versioned()`. Versions before 13 cannot read what
version 13 writes.

### Reading the past

A pulse holds the history of its document, so reading it needs no server:

```ts
import { getPulseHistory, snapshotPulse } from "pulsify-core";

// The writes of a versioned field, oldest first.
getPulseHistory(invoice, "total");
// [{ value: 10, version, actor, time }, { value: 12, version, actor, time }]
getPulseHistory(invoice, ["customer", "name"]);          // a path of keys
getPulseHistory(invoice, "total", { since: lastMonth }); // a Date, or a version

// Every transaction of the document.
const versions = getPulseHistory(invoice); // [{ version, actor, clock, time?, migration? }]

// The document as it was.
const first = snapshotPulse(invoice, { at: versions[0].version });
const monday = snapshotPulse(invoice, { at: new Date("2026-11-16T09:00") });
```

- **A version** is a version vector, the one `getPulseVersions` returns:
  plain data, to store or send. Versions are ordered the same way on every
  replica, and each one is the document after one more transaction.
- **`since` and `until`** are a `Date`, compared with the `time` of each
  write, or a version: `since` keeps what that version does not include,
  `until` what it includes.
- **A field** must be `versioned()`, or a text: any other field has no past,
  and asking for it throws. Its entries are the transactions that wrote it,
  or anything inside it when it is an object, an array or a text, the one at
  creation included; a deleted field has the value `undefined`.
- **`snapshotPulse(pulse, { at })`** needs a document whose whole schema is
  `versioned()`, so that the copy is exact, and `timestamps` to take a date:
  the copy is then the transactions written up to that date. The migrations
  added since that version are applied to the copy.
- **`actor` and `clock`** name the transaction: the [actor](#actor-ids)
  that wrote it, and its sequence number among those of that actor. An actor
  is a number a page or a device writes under, not a user. A server that
  authenticates its connections can tell whose it is: with Pulsify Cloud,
  `cloud.actorSubject(pulse.id, version.actor)` resolves to the user's ID,
  and `cloud.authors(pulse.id)` to who sent each transaction (see
  [pulsify-cloud](../cloud/README.md#who-wrote-a-document)).
- **`migration: true`** marks a transaction Pulsify wrote itself, when a
  client loaded the document with a newer definition. Its actor is that
  client's, which ran the migration: nobody edited the document.
- **Cost.** Each call replays the history. A pulse that received a
  [condensed state](#hybrid-state-exchange) calls `recoverPulseHistory` first.

### Restoring

```ts
import { restorePulse } from "pulsify-core";

restorePulse(invoice, versions[3].version); // a version of its history
restorePulse(invoice, new Date("2026-11-16T09:00"));
restorePulse(invoice, saved);               // a snapshot, see below
```

A restore is a write like another. It travels to every replica and stays in
the history, so restoring the version before it undoes it. It does not rewind
anything: it replaces the whole document by a new **generation** of it, with
the content of the version, texts with their formatting.

- **`pulse.generation`** starts at 0 and grows by one with each restore.
- **Edits made to an earlier generation are discarded**, on every replica and
  whatever the order of arrival: someone who kept typing without having
  received the restore loses those edits when it arrives.
- **Two restores made apart.** When two people restore while offline and keep
  editing, one restore wins on every replica, with the edits that followed
  it; the other one and its edits are discarded. The later generation wins,
  then the later write.
- **Objects, arrays and texts read before the restore are replaced**, and
  using them throws. Read them from the pulse again, and bind an editor
  again when `pulse.generation` changes (a `key` in most frameworks).
- **Sub-pulses** are documents of their own: restoring a parent restores its
  references, not the documents they point to.
- **Fields a migration retired** stay in storage but are not restored.
- **Nothing is written unless every replica will accept it**: a restore is
  checked as a receiver checks it first, and throws otherwise.
- **What travels.** Where the document keeps every write up to that version,
  the restore only names it: a few bytes, and every replica rebuilds the
  version from its own history, whatever its size. That is any version of a
  document that was always `versioned()`. Where a write replaced another
  one, the restore carries the content, which must fit one transaction: a
  document over 1 MiB is refused with `LIMIT_EXCEEDED` before anything is
  written.

- **Cost.** A restore is meant to be occasional. The generation it replaces
  stays in memory, since edits still on their way to it are valid, and a
  restore that names a version is rebuilt from the history each time the
  document loads.

Versions before 15 cannot read a document that was restored.

### Snapshots

For a document that keeps every write, a snapshot is its version: plain
data, to store anywhere and give back to `snapshotPulse` or `restorePulse`.

```ts
import { getPulseVersions } from "pulsify-core";

const version = getPulseVersions(invoice).state; // [[actor, clock], …]
restorePulse(invoice, version);
```

A document that is not `versioned()` keeps no past: keep copies of it at the
moments that matter instead. A copy is the frames of the document, which hold
what it has now and nothing of what it dropped:

```ts
import { exportPulseUpdates, openPulseSnapshot, restorePulse } from "pulsify-core";

const frames = exportPulseUpdates(note, []); // Uint8Array[]: store them anywhere

const saved = openPulseSnapshot(Note, note.id, frames);
saved.title;               // read it, render it with the same components
restorePulse(note, saved); // or bring it back
destroyPulse(saved);
```

`openPulseSnapshot` takes exact update frames, the ones `exportPulseUpdates`
gives by default, and returns a read-only pulse that belongs to no scope and has
no connector. The migrations added since the copy was made are applied to it,
so an old snapshot opens, and restores, with today's schema. Restoring one
names its version when the document still holds every row of it, and carries
its content otherwise.
[Pulsify Cloud](../cloud/README.md) keeps snapshots on the server, with their
time and author.

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
text. Declare a `plainText()` field and bind CodeMirror to it:

```ts
import { bindCodeMirror } from "pulsify-codemirror";

const binding = bindCodeMirror(view, file.code);
binding.destroy();
```

- [CodeMirror API and example](../pulsify-codemirror/README.md)

## Connect and load

```ts
import {
  connectPulse, createWebSocketConnector, loadPulse, disconnectPulse,
} from "pulsify-core";

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

A call while an attempt is in progress returns that attempt's promises: they settle with it, on its deadline and signal, not the new call's. A call after a successful attempt returns it only while every connector still covers the local history, so an edit made just before is always awaited.

`loadPulse` waits for `ready` by default. `waitFor` accepts `"connected"`, `"synced"`, `"all"` (alias of `"synced"`) or an array of configured connectors, which waits for those only: an unrelated connector neither delays nor fails the load. A load keeps its own `timeoutMs` and `signal` even when it joins a pulse that is already loaded or connecting: they reject that load, without stopping the synchronization it joined, which may also settle it earlier. Missing documents, non-retryable errors, aborts and `timeoutMs` settle the promises with a `PulseError`; an earlier `ready` may already have succeeded. Pass `signal` to cancel initial loading. With no connectors, a created document resolves immediately and loading an unknown ID rejects with `NOT_FOUND`.

### Reconnection

`connectPulse` means "stay synchronized with every connector, local or remote, until `disconnectPulse` or `destroyPulse`". Each connector has its own lifecycle:

- A closed transport, a failed opening or a request without an answer within `timeoutMs` (counted from the last page, for a paged download) (`CLOSED`, `CONNECTION_FAILED`, `TIMEOUT`, see `isRetryable`) puts the connection in `reconnecting`. It retries after `initialDelayMs × factor^n`, capped at `maxDelayMs` and shortened by up to `jitter` at random (`reconnect` option, defaults 250 ms, ×2, 30 s, 0.25; `false` gives up after one failure).
- Every new session is a complete synchronization: the connector's state is considered unknown, so the session sends the local version vector, downloads what is missing and uploads everything the connector has not acknowledged.
- `FORBIDDEN`, incompatible documents, invalid frames and exceptions thrown while applying received data (for example by a migration) stop that connector with status `error`. A connector can mark any error with `new PulseError(code, message, { retryable })`.
- Lazy waking: when a pulse has rows to upload (a local edit) while a connector is down, that connector retries within a second instead of waiting for the full backoff, and at most once a second while it stays down. Passive documents keep their backoff.
- `onError` receives one report per outage, not one per attempt. Connections emit `reconnecting(error, delayMs, attempt)`, and expose `status`, `attempt` and `lastError`.
- The browser's `online` event and `setOnlineMode(true)` retry waiting connections at once and probe established ones; while `navigator.onLine` is false or `setOnlineMode(false)` is set, attempts wait. Between those events, connectors detect transports that died without closing, once per socket (the cloud connector pings idle sockets); a connector reports it with `onClose(error)`. A session that sets `heartbeatMs` is probed after that long without a received frame: `createWebSocketConnector` does every 30 s (`{ heartbeatMs }`, `false` to disable), which detects a socket that a NAT or proxy dropped silently.
- `timeoutMs` bounds the promises, not the intent: after a `TIMEOUT` the connectors keep trying. Calling `connectPulse` again after a settled attempt returns new promises and retries failing or stopped connectors at once.

`getPulseMeta(pulse).status` is `idle`, `syncing`, `ready`, `synced`, `offline` (a connector is being retried) or `error`; `subscribePulseStatus(pulse, (status) => …)` reports it now and on every change. Its engine/journal fields are internal state: do not mutate them directly.

## Sub-pulses

A pulse can hold the IDs of child pulses. A child is a separate document with
its own history and version vector, so it loads and synchronizes on its own;
its ID is prefixed by the parent ID, which lets a server co-locate a whole tree.

```ts
import { array, createPulse, definePulse, loadPulse, object, sub, pulseRef } from "pulsify-core";

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
user.projects.push(pulseRef(project));

const ref = user.projects[0]!;    // PulseRef<typeof Project>
ref.id;                           // The stored value
ref.pulse;                        // Pulse<Project> | undefined: loaded in this scope?
await ref.load();                 // loadPulse with the parent's scope and connectors

await loadPulse(User, "1234", { connectors }); // With every sub-pulse, recursively
const lazy = await loadPulse(User, "1234", { connectors, subPulses: false }); // The user only
await Promise.all(lazy.projects.map((ref) => ref.load({ subPulses: false }))); // Its projects, not their documents
await loadPulse(Project, "1234/xyz", { connectors }); // A child without its parent
```

`sub(Definition)` is a string field on the wire; snapshots and migrations see the
ID. Reads return a reference; writes accept a reference, a pulse or an ID string at
runtime, and `pulseRef(pulse)` produces the typed reference. `{ parent }` prefixes
the generated ID, rejects an explicit ID outside the parent, and inherits the
parent's scope, connectors and other options. `loadPulse` loads every sub-pulse recursively, `ref.load()` included, through
arrays, maps and optionals; `subPulses: false` loads none, and you load the ones
you need with `ref.load()`. `setDefaultPulseOptions({ subPulses: false })` makes
every load lazy. Sub-pulse loads use the same `waitFor`. While connected with
`subPulses: true`, newly referenced sub-pulses added by other peers are also
loaded automatically (and on Pulsify Cloud their initial data is pushed ahead of
the parent update so `ref.pulse` is ready immediately). Whenever a referenced
sub-pulse enters or leaves the scope, the parent's subscribers and reactive
views are notified. Creating a child and linking it from its parent are two
documents and two writes; a dangling ID is tolerated: it does not fail the load
of its parent and resolves to `pulse === undefined` until the child exists. Any
other error of a child rejects the whole load.

## Presence

Presence is live state that every connected peer publishes for itself and
that everyone subscribed to the pulse sees until that peer leaves: who has a
document open, a pointer, a selection. It is never stored and never enters the
document's history.

```ts
import { definePresence, joinPresence, object } from "pulsify-core";

const Viewer = definePresence("viewer", object({ name: "string", color: "string" }));
const Cursor = definePresence("cursor", object({ x: "float32", y: "float32" }), { throttleMs: 30 });

const viewers = joinPresence(project, Viewer);
viewers.set({ name: "Ada", color: "#e5484d" }); // sent now, and again after every reconnection
viewers.mine;                                   // { name: "Ada", color: "#e5484d" }
viewers.others;                                 // [{ peer: 7, subject?: "…", state: { name, color } }, …]
const stop = viewers.subscribe(({ others }) => render(others)); // now, then on every change
viewers.set(undefined);                         // no state any more; the others stay visible
viewers.leave();                                // undo this joinPresence
```

- **Channels.** `definePresence(name, schema, { throttleMs })` takes any codec
  schema, except an array or set whose elements take no bytes (`null`,
  `undefined`, a literal, an empty object or tuple): its length could not be
  bounded by the size of the state. A state is validated, replaced as a
  whole, and limited to 16 KiB once encoded. Use one channel per kind of state. Peers see each other in a
  channel when its name and schema layout match: another schema under the
  same name is another channel, so there are no migrations.
- **Peers.** A peer is one connected session of the document (a tab, a
  window, a device), numbered by the relay, with the same number in every
  channel of the pulse. It is not the actor ID: readers have a peer and no
  actor, and a reconnection is a new peer. `subject` is the identity the relay
  authenticated, when it did; a state is only what its peer says.
- **Values.** `others` is a frozen array that changes identity only when
  something changed, and a peer whose state did not change keeps the same
  object. `mine` is a detached copy of what was set. `subscribe` calls its
  listener at once, then synchronously after every change of `others` or
  `mine`, and a last time when its holder leaves, with the presence itself.
- **Sending.** A channel sends its first state at once, then the latest one
  at most every `throttleMs` (50 by default). Nothing is sent while the state
  does not change; there is no heartbeat.
- **Lifecycle.** `joinPresence` works on any pulse, connected or not. Offline,
  `others` is empty and `mine` is kept, then sent when a connection that
  relays presence is established. Joins are counted: each one is undone by
  its own `leave()`, which is idempotent, and the channel closes with the
  last. `destroyPulse` closes every channel. A peer that closes its tab,
  loses the network or its access is removed by the relay.
- **Readers** publish presence: it is not a write to the document.
- **Where.** Presence goes through relays: the memory connector,
  `createWebSocketConnector(url, factory, { presence: true })` for a relay
  running version 10 or later, and Pulsify Cloud. Local stores (IndexedDB,
  Electron, Tauri) do not relay it. A pulse uses one relay for presence: the
  first connector, in order, whose session relays it, until that session
  fails. A custom connector sets `ConnectorSession.presence` once its
  endpoint is known to relay kind 7.

The four framework bindings wrap exactly this object: `usePulsePresence`
(`pulsify-react`, `pulsify-vue`), `new SveltePresence` (`pulsify-svelte`) and
`createPulsePresence` (`pulsify-solid`).

### Text positions

An index into a `richText()` field moves when someone types before it. An
anchor does not:

```ts
const caret = note.body.anchorAt(5); // follows the character before index 5
note.body.insert(0, "Hey ");
note.body.indexOf(caret);            // 9
```

An anchor is a plain string: the ID of the entry before the position, or of
the field itself for its start. It stays after that entry, so text inserted
exactly there lands after the anchor, and it resolves to where the entry was
once it is deleted. `indexOf` returns `undefined` for an anchor of another
field, or of a character this replica has not received yet; resolve it again
after the document changes. Publish anchors in presence, or store them in a
pulse to pin a comment. `RichTextSelection` is the presence channel
(`{ anchor, head, name, color }`) that the ProseMirror and Lexical bindings
share selections on; both expose the same anchors in editor positions.

### Relaying presence

`PulseRelay` relays presence as it is. `relay.open(send, { docId, readOnly,
subject })` names the user you authenticated, which every peer reads as
`peer.subject`. A server that owns its sockets and calls `relayStoreMessage`
does the forwarding itself:

```ts
import { encodeBroadcastFrames, encodePresenceLeave, relayStoreMessage } from "pulsify-core/protocol";

// peer: a positive number no other open session of the document uses.
const result = await relayStoreMessage(store, bytes, { docId, readOnly, peer, subject });
for (const frame of result.responses) socket.send(frame);
if (result.presence) session.presence = true; // this client understands presence
for (const other of othersOf(docId, socket)) {
  if (result.broadcast)
    for (const frame of encodeBroadcastFrames(docId, result.broadcast)) other.send(frame);
  const { presence } = result;
  if (presence && other.presence && (!presence.to || presence.to === other.peer))
    other.send(presence.frame);
}
// When a session ends:
for (const other of othersOf(docId, socket))
  if (other.presence) other.send(encodePresenceLeave(docId, peer));
```

Forward presence only to sessions that have sent a presence frame themselves:
clients older than version 10 reject it. A relay stores nothing; it may drop
frames beyond a rate with `createPresenceBudget()`. The wire format is in the
[protocol specification](../../docs/PROTOCOL.md#presence-kind-7).

## Client scopes and in-memory synchronization

One scope contains one public instance per document ID and definition. Reusing an ID returns the existing materialized instance. Use separate scopes for different clients, tests, requests or tenants.

```ts
import {
  createMemoryConnector, createPulseScope, PulseRelay,
} from "pulsify-core";

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

## Actor IDs

Every write is recorded under an actor ID, one per writing replica, and a document accepts up to 1024 of them. So that reloads do not use them up, a page reuses the IDs of pages that are gone.

Wherever a page has [Web Locks](https://developer.mozilla.org/docs/Web/API/Web_Locks_API) and `localStorage` (browsers, and webviews such as Electron, Tauri or Electrobun), each scope leases one actor ID for the life of its page. The IDs a browser profile has used are listed in `localStorage`. The page using one holds a Web Lock on it, which the browser releases when the tab or window goes away, crashes included, and the next page takes the first free ID. A profile therefore uses as many IDs as it ever had pages open at once, and no native code is involved.

An actor's history must stay a single sequence, so a pulse writes under the leased ID only when it has every row that ID already wrote to the document:

- a document that `createPulse` creates under a generated ID has none;
- a loaded document has them once every one of its connectors has answered a complete download.

A pulse that writes earlier, while offline or before a slow remote answers, uses a random actor until it is destroyed. So does `createPulse` with a caller-chosen `id`, which may name an existing document. Without Web Locks or `localStorage` (insecure origins, workers, Bun, Node), every pulse uses a random actor.

- **One list per store.** A local connector names its list with `actorPool`; the IndexedDB, Electron and Tauri connectors do. Pulses without a local connector share one list per origin, and a local connector without `actorPool` gets random actors. Open a document with the same connectors each time.
- **One process per profile.** Two instances of a desktop app over the same profile directory do not see each other's locks; allow a single instance.
- **Back/forward cache.** Chromium and Firefox currently reload a page that holds a Web Lock instead of restoring it from the back/forward cache.
- **`sessionId`** sets the actor yourself and skips the lease: a safe integer >= 65536, unique among the writers of a document.

### Actors and accounts

An actor says nothing of the user, and a browser profile may serve several accounts in turn. Give each account its own scope:

```ts
import { createPulseScope, setDefaultPulseOptions } from "pulsify-core";

// On sign-in, with an ID your application knows while offline too.
setDefaultPulseOptions({
  scope: createPulseScope({ identity: user.id }),
  connectors: [remote, local],
});
```

- **One list per identity.** A scope with an `identity` leases from lists of its own, so two accounts never write under one actor, even on one profile and one local store. Use a new scope, and new remote connectors, when the user changes, and never load the pulses of an account into the scope of another. Do not erase the local store on sign-out: it may hold writes that were not uploaded yet.
- **`identity` proves nothing.** It keeps actors apart on the device. A server decides who a connection is from its credential: Pulsify Cloud binds an actor to the subject of the token, and refuses a scope whose `identity` is not that subject. Use the same string for both.
- **Own actors.** A pulse that has connectors records the actor it writes with: in memory, and for a scope with an `identity` in `localStorage` too (the last 4096). A connector is told which actors are the scope's own (`declareActors`): the leased one when it connects, and before an upload those of its rows. An endpoint can then bind them to the account of the session; rows of any other actor are relayed, and never declared. The stored record is what lets a later page upload a write made offline as its own. Without an `identity` or without `localStorage`, a page or a process that restarts with writes not uploaded yet relays them like anyone's.
- **Refused actors.** An endpoint may answer that a declared actor belongs to another account (`onActorsRefused`), as happens when two accounts share actors for want of an `identity`. The pulse then reports a `FORBIDDEN` error to `onError` and writes under another actor from its next write on; a leased actor that was refused is not chosen at all.

## Migrations and materialization

```ts
import { createPulse, definePulse, object, type PulseProperties } from "pulsify-core";

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
import { definePulse, object } from "pulsify-core";

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

`setDefaultPulseOptions` changes defaults; individual calls can override `createId`, `connect`, `connectors`, `scope`, `timeoutMs`, `onError` and an optional numeric `sessionId`. Usually leave it unset, so that [actor IDs](#actor-ids) are leased and reused; explicit IDs must be safe integers >= 65536 and unique among writers of a document.

A `Connector` supplies `kind: "local" | "remote"`, for a local store an optional `actorPool` name (see [Actor IDs](#actor-ids)), and `open({ docId, identity, signal, onMessage, onClose })`, returning a session with asynchronous `send(Uint8Array)` and idempotent `close()`. `identity` is the one of the pulse's scope, for a connector that authenticates as an account; a session may also implement `declareActors(actors)`, called with actors the scope created itself, and answer through `onActorsRefused(actors)` of `open` (see [Actors and accounts](#actors-and-accounts)). Deliver complete binary frames, honor cancellation and report transport closure. A WebSocket factory can be supplied to `createWebSocketConnector` for custom runtime/authentication integration, and a `{docId}` placeholder in its URL is replaced per session for servers that route before the first frame. See the [protocol specification](../../docs/PROTOCOL.md).

Authorization is a server decision taken at the session boundary, outside the replicated data. `PulseRelay.open(send, { readOnly: true, docId })` serves connect and sync and answers any upload with `FORBIDDEN`; `docId` pins the session to one document before its connect frame. `relayStoreMessage(store, frame, session)` serves one frame directly from a `PatchStore` without an in-memory journal, committing rows before the acknowledgement and returning the frames to send back plus the rows to send to the document's other peers with `encodeBroadcastFrames` (bounded frames, encoded once per envelope). `pulsify-cloud-server` builds a managed backend on these pieces: one actor per root pulse (a Cloudflare Durable Object), one multiplexed WebSocket per user and root, and reader/editor/owner grants stored in each root.

Durable operation stores are available from `pulsify-core/storage` for
PostgreSQL and SQLite; any other database can implement the exported
`PatchStore` interface. Stores append binary rows and query missing
operations by version vector without loading a document. PostgreSQL's append
is one database call; connect storage to your relay and commit before
acknowledging writes. See the [storage adapter guide](../../docs/STORAGE.md).

The codecs compile trusted, fixed schemas with generated JavaScript functions. Browser deployments need a Content Security Policy that permits that code generation; received frames never supply executable schemas.

## Exact grouped updates

For a peer known to support the current grouped transport:

```ts
import { exportPulseUpdates, applyPulseUpdates } from "pulsify-core";
const frames = exportPulseUpdates(article, remoteVector, { peerVersion: 2 });
applyPulseUpdates(otherArticle, frames);
```

These envelopes carry the writes of [`versioned()`](#history) fields: a field
without history already sends its last write only. This is the same exchange
implementation used by connectors. Omitting
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
} from "pulsify-core";
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

### Compact single writes

Between two pulses of the same document, `{peerVersion: 4}` also sends a lone
string or number field write as a compact frame, about a quarter of the size of
the exact one. The receiving pulse rebuilds the exact original operation, so its
journal and storage are unchanged:

```ts
const frames = exportPulseUpdates(article, remoteVector, { peerVersion: 4 });
applyPulseUpdates(otherArticle, frames);
```

Only `applyPulseUpdates` reads this frame: relays, stores and `decodeMessage`
reject it, and connector sessions keep the earlier formats. Everything other
than a single scalar write behaves as `peerVersion: 3`. See
[compact writes](../../docs/PROTOCOL.md#optional-compact-writes-envelope-4).
