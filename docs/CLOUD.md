# Pulsify Cloud protocol

Cloud session protocol **1**. It carries the unchanged Pulsify frames described
in [PROTOCOL.md](PROTOCOL.md) (envelopes 1 and 2, operations version 3) and
adds routing, authentication, multiplexing and access control. Every backend
(`pulsify-cloud-server/cloudflare`, `pulsify-cloud-server/local`) implements
this document; the conformance suite in
[`packages/cloud-server/core/tests/conformance.ts`](../packages/cloud-server/core/tests/conformance.ts)
is the executable authority. Run it with
`bun run test:cloud --backend cloudflare`, and against the local server with
`bun test packages/cloud-server`.

## Hosted service

The hosted service serves projects at `https://api.pulsify.cloud/<project>`,
where `<project>` is 16 characters of `[a-z2-7]`: `GET
https://api.pulsify.cloud/<project>/v1/health`. The `/<project>` prefix is
stripped before the protocol below applies. Each project has its own
`PULSIFY_TOKEN_SECRET`, its own `PULSIFY_API_KEY` and its own roots; a rotated
secret stops working within a minute.

Plans meter the binary frames clients send (`connect`, `syncBack`, `update`;
presence frames and broadcasts do not count), the size of the roots'
databases, and the live sockets across all roots. At the limits:

- Free, over messages or storage: `syncBack` and `update` get a
  `LIMIT_EXCEEDED` error frame; `connect`, sync and broadcasts keep working.
- Any plan, over its connection limit: the upgrade is refused with
  `LIMIT_EXCEEDED` (413). Open sockets stay open.
- Pro: usage beyond the included amounts is billed, never refused.

Deleting a project from the dashboard closes its sockets with 1008 and erases
its roots; its URL then answers `NOT_FOUND`.

The metering does not depend on the host. It is a `CloudMeter`
(`pulsify-cloud-server`), which a host calls at four moments: a socket asks to
open, a management request arrives, a client sends a binary frame, and a
socket closes or the root is erased. A host that calls it enforces the plans.

## Local server

`pulsify-cloud-server/local` serves this protocol on one machine, for
development: `bun run pulsify dev`. It needs Bun. It answers at
`http://127.0.0.1:3345/<project>` for any `<project>` of 1 to 64 characters of
`[a-z0-9-]`, and strips the prefix like the hosted service. Every project
shares one token secret and one API key: `PULSIFY_TOKEN_SECRET` and
`PULSIFY_API_KEY`, or development secrets that the command prints. Nothing is
metered unless the server is given a `CloudMeter`.

Each root is one SQLite file, `<directory>/<project>/<root>.sqlite`, in
`.pulsify` by default. In the file name, lower-case letters, digits, `-` and
`_` stay and every other byte of the root is `%xx`; a name over 200 characters
is `~` followed by the SHA-256 of the root. A root lives like a Durable Object:
it is in memory while it has sockets or waits to compact or expire, and
[compaction and expiry](#storage) follow the rules below with a timer in place
of the alarm. The timer does not survive the process: a root that was waiting
when the server stopped compacts or expires after its next socket closes.

## Roots

A document belongs to the root named by the part of its ID before the first
`/`: `toto/tata/x` belongs to `toto`. A root is an isolated namespace and the
unit of placement: one actor (a Durable Object on Cloudflare). All
events of a root are processed in arrival order, one at a time.

Root IDs follow the document ID rules (well-formed Unicode, no NUL, at most
1,024 UTF-16 units) and contain no `/`. In URLs the root is one
percent-encoded path segment.

## Identity and grants

A user is identified by an HS256 JWT signed with `PULSIFY_TOKEN_SECRET`
(at least 32 characters):

```text
header:  {"alg":"HS256","typ":"JWT"}
payload: {"sub": subject, "aud": "pulsify-cloud", "exp": seconds, "iat": seconds}
```

`sub` is 1–256 UTF-16 units, not `*`. `aud` must contain `pulsify-cloud`; `exp`
is required and `nbf` is honored. Tokens carry no rights.

The management key `PULSIFY_API_KEY` (at least 32 characters) authenticates the
application's servers. It is compared in constant time.

Each root stores its grants: `(subject, prefix, role)` with a unique
`(subject, prefix)`. `prefix` is a document ID inside the root; `subject` is a
token subject or `*` (every authenticated user). Roles are ordered
`reader < editor < owner`:

| Role | connect, sync, receive updates | syncBack, update | manage grants under the prefix |
| --- | --- | --- | --- |
| `reader` | yes | `FORBIDDEN` | no |
| `editor` | yes | yes | no |
| `owner` | yes | yes | yes |

The role of a subject on a document is the strongest grant whose subject is the
user or `*` and whose prefix equals the document ID or is followed by `/` in it
(`u1/a` covers `u1/a/b`, never `u1/ab`). A root holds at most 10,000 grants.

## Credentials

A request's credential is, in order: `Authorization: Bearer <credential>`, the
`pulsify-cloud.token.<jwt>` WebSocket subprotocol, then the `token` query
parameter. The API key yields the admin caller; anything else must be a valid
token, or the request fails with 401.

## HTTP API

Every response carries `Access-Control-Allow-Origin: *`; `OPTIONS` on any path
answers 204 with the allowed methods and headers. Bodies are JSON. Errors are
`{"error":{"code","message"}}`:

| Code | Status |
| --- | --- |
| `BAD_REQUEST` | 400 |
| `UNAUTHORIZED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `METHOD_NOT_ALLOWED` | 405 |
| `LIMIT_EXCEEDED` | 413 |
| `UPGRADE_REQUIRED` | 426 |
| `UNAVAILABLE` | 503 |

| Request | Caller | Response |
| --- | --- | --- |
| `GET /v1/health` | anyone | `{"ok":true}` |
| `GET /v1/roots/{root}/grants[?subject=&prefix=]` | admin: all grants; user: grants they own the prefix of, and their own | `{"grants":[grant…]}` sorted by prefix then subject (UTF-16 order) |
| `PUT /v1/roots/{root}/grants` body `{subject,prefix,role}` | admin, or an owner of `prefix` | `{"grant":grant}` |
| `DELETE /v1/roots/{root}/grants?subject=&prefix=` | admin, or an owner of `prefix` | `{"removed":boolean}` |
| `GET /v1/roots/{root}/usage` | admin | `{"root","documents","rows","bytes","connections"}` |
| `DELETE /v1/roots/{root}/documents?docId=` | admin, or an owner of `docId` | `{"deleted":number}` |
| `PUT /v1/roots/{root}/expire` `{"idleMs":number}` | admin, or an owner of `root` | `{"idleMs":number}` |
| `POST /v1/roots/{root}/snapshots?docId=` body `{label?}` | admin, or an editor of `docId` | `{"snapshot":snapshot}` |
| `GET /v1/roots/{root}/snapshots?docId=[&since=]` | admin, or a reader of `docId` | `{"snapshots":[snapshot…]}` sorted by time |
| `GET /v1/roots/{root}/snapshots?docId=&id=` | admin, or a reader of `docId` | the frames of the snapshot, as bytes |
| `DELETE /v1/roots/{root}/snapshots?docId=&id=` | admin, or an owner of `docId` | `{"removed":boolean}` |
| `GET /v1/roots/{root}/actors?docId=&actor=` | admin, or a reader of `docId` | `{"subject":string\|null}` |
| `GET /v1/roots/{root}/authors?docId=` | admin, or a reader of `docId` | `{"actors":[[actor,subject]…],"received":[range…]}` |

The `prefix` filter keeps grants whose prefix it covers. Bodies are limited to
64 KiB.

### Deleting documents

`DELETE …/documents?docId=` permanently retires that document ID and every
`docId/…` descendant. It erases their operation data and grants and leaves a
durable prefix tombstone. The operation is idempotent, including when no data
has arrived yet. `deleted` counts documents whose stored data was erased.
Removing a reference alone does not delete its target.
Protection applies to deletions recorded by version 14 or later. Previously erased
IDs can be retired by deleting them again, even if they currently contain no rows.

A covered ID can never be reused. A new document needs a new ID. This includes
root names: deleting `alice` permanently retires that namespace. Tombstones have
no expiry and survive compaction, restart and Durable Object hibernation.
Cloudflare closes a deleted root's sockets and cancels its alarm but retains
its storage and tombstone. Restoring a backup from before a deletion also
restores the earlier lifecycle state; keep backups consistent with deletion policy.

Reads and uploads to deleted IDs fail with a terminal `NOT_FOUND` error frame,
never an empty `found:false` sync that would invite an upload. Even unseen
descendants created offline are rejected. Permission checks still happen first;
a user whose grants were removed may see `FORBIDDEN`. New grants beneath a
retired prefix are rejected. The server never edits references in parent documents.

Updated clients stop the document and remember authoritative deletion in local
stores. They preserve local operations for explicit recovery (`recoverRows` on
SQLite/IndexedDB, `recover_rows` on native stores) and keep an already loaded
pulse readable through `snapshotPulse`. Normal loading and editing are blocked.
Copy recovered content into a new ID to publish it again. A normally absent
document, or a failure from an arbitrary peer, is not proof of permanent deletion.
Offline devices learn deletion when they next contact the authority; a server
cannot invalidate an unreachable device immediately.

### Snapshots

A snapshot is a document as the root holds it when asked: the rows of its
store, which the root never decodes. It is the way to keep past states of a
document whose fields are not `versioned()`: the copy has the size of the
document, not of its edits.

A document none of whose writes has replaced another keeps every row it has,
so its snapshot is its version alone and stores no row: reading it serves the
document's rows below that version. That is every document that was always
`versioned()`, and the store tells by holding no last-value row for it.

```text
snapshot: {"id":string,"docId":string,"time":number,"label"?:string,"subject"?:string,"version":vector}
```

`time` is the server's clock in milliseconds, `subject` the subject of the
token that asked (absent with the API key), `version` the document's vector
at that moment, and `label` a string of 1 to 256 characters. `since` is a
time in milliseconds: the list keeps the snapshots made at or after it.
`POST` answers `NOT_FOUND` for a document without rows or one that was
deleted. Only what the root has received is copied: a client snapshots after
its edits are acknowledged (`synced`).

Reading one snapshot answers `application/octet-stream`: update frames (kind
4, envelope 1, request ID 0, empty vector) one after the other, each after
its length as a big-endian `uint32`, streamed as they are made. A client
applies them to a pulse of its
own (`openPulseSnapshot`, which `loadSnapshot` of the management client
calls): the migrations added since are applied there, and restoring is a
write that client makes (`restorePulse`), sent like any edit. The server
never restores anything.

Snapshots live in the root's database. A copy is kept in frames of about
512 KiB, so that each fits a row of any host, and counts in `usage` bytes. Deleting a document
erases its snapshots and those of its sub-documents; an expired root takes
them with it. `CloudRootStorage.saveSnapshot`, `listSnapshots`,
`loadSnapshot` and `deleteSnapshot` are optional: a backend without them
answers `BAD_REQUEST`. Without `keepsEveryRow`, every snapshot is a copy.

### Authors

Every write of a document is recorded under an actor: a number a client
writes under, which says nothing of the user. A root knows two more things,
both from the token of a connection and never from what a client sends about
itself.

**Whose actor it is.** Before a client uploads rows of an actor it created
itself, it declares the actor (the [`actors` text frame](#text-frames)). The
root binds the actor to the subject of the socket's token, in
`pulsify_cloud_actors(sid, subject)`. The binding is the root's, shared by
all its documents, and permanent: a later declaration by another account is
refused and changes nothing, and so is one from a session that cannot write
the document it names. One actor has one account; an account has as many
actors as its devices and pages needed.

`GET …/actors?docId=&actor=` answers the subject an actor is bound to, or
`null`: `cloud.actorSubject(docId, actor)`. A user asks about the actors that
wrote a document they can read, and gets `null` for any other actor of the
root, bound or not; a deleted document answers them `NOT_FOUND`. The API key
asks about any actor of the root, whatever the document. `actor` is an
integer from 65536, or the request fails with `BAD_REQUEST`.

**Which account sent each write.** A client also uploads rows it did not
write: those another replica gave it offline or through another connector.
So the root notes, for every row it stores, the subject of the socket that
delivered it, in the transaction that stores the row: a refused upload notes
nothing, and a row sent again keeps its first sender.
`pulsify_cloud_received(doc_id, sid, clock, clock_end, subject)` holds one
range of sequence numbers per run of an actor's rows that one account sent,
so a client that uploads as it writes costs one row per actor and document.

`GET …/authors?docId=` answers both for one document:

```text
actors:   [[actor, subject]…]    the actors that wrote the document and have an account
received: [{"actor","clock","end","subject"}…]   sorted by actor, then clock; `end` is exclusive
```

A transaction `(actor, clock)` was received from the subject of the last
range of its actor with `clock <= its clock < end`. It is *verified* when
that subject is the one its actor is bound to: the account that claimed the
actor sent the write itself. Anything else is unverified: a write relayed by
another account, a write whose actor nobody claimed, or a row stored before
the root kept authors. `cloud.authors(docId)` returns `of(version)`, which
answers `{subject?, receivedFrom?, verified}`.

What this proves, and what it does not:

- A verified write was sent under the token of its actor's account. No other
  account can make a write verified for that account: it can neither take
  the actor nor have its own uploads counted as sent by the actor's account.
- An actor nobody has claimed yet belongs to the first account that declares
  it. That is a statement by an authenticated account, not a proof that it
  created the actor: an editor who learns of an unclaimed actor can claim
  it, and thereby take credit for what it then uploads, never give it away.
  The binding is the root's, so an editor of one document can claim an
  unclaimed actor seen in another document of the root that it only reads.
  The actor's real account is then refused, and its client stops using it.
- An editor can still write rows under another account's actor. They are
  stored, as the protocol accepts them, and are unverified: `receivedFrom`
  names the editor. The actor still answers its account to
  `actorSubject`, which says whose the actor is, not who sent each write.
- Clients must not share actors between accounts. The reference client
  keeps them apart when each account has its own scope
  (`createPulseScope({ identity })`); without one, the accounts of a browser
  profile lease the same actors, the second account's declaration is
  refused, and its client writes under another actor from then on.
- Writes are not signed. A write relayed by another account stays
  unverified, even after its actor is claimed. What a hostile editor can do,
  and what closing it would cost, is in
  [AUTHOR-VERIFICATION.md](AUTHOR-VERIFICATION.md).
- A [migration](../packages/pulse/README.md#migrations-and-materialization)
  is written by the first client that loads the document with a newer
  definition: its author is that client's account, which edited nothing.
  `getPulseHistory` marks these versions with `migration: true`.
- A restore is a write of the account that restores. The versions before it
  keep their authors.

Both tables live in the root's database and survive hibernation and
compaction, which changes no sequence number. Deleting a document erases
what was received for it and its sub-documents; deleting the root document
erases the actors too, and an expired root takes everything with it. A
[snapshot](#snapshots) holds rows of its document, so their authors are
those of the document for as long as it exists; frames exported from a
pulse and applied elsewhere carry no author, and are received from whoever
uploads them.

## WebSocket sessions

`GET /v1/roots/{root}/connect` with a WebSocket upgrade. Checks, in order:
upgrade header (426), an offered session subprotocol (400), a user token (401).
The client offers, in preference order:

```text
pulsify-cloud.1.e2, pulsify-cloud.1.e1, pulsify-cloud.token.<jwt>
```

The server selects `pulsify-cloud.1.e2` or `pulsify-cloud.1.e1` and never
echoes the token. The selection fixes the highest Pulsify envelope the client
may send; the server may answer any session with envelope 1. Any authenticated
user may open a socket on any root: rights are checked per document so that
clients receive a `FORBIDDEN` frame rather than a refused upgrade, whose
status browsers hide.

One socket serves any number of documents of its root. The client opens one
socket per root and routes incoming frames by the document ID in their header
(`version, operations, kind, docId, requestId`). Request IDs are unique per
document, not per socket.

### Binary frames

Each frame is processed as follows:

1. An envelope above the negotiated one, or a frame that does not decode,
   closes the socket with 1008.
2. A document outside the root: error frame `FORBIDDEN`.
3. `connect` (kind 1): without a role, send the role message `null`, then
   `FORBIDDEN`, and drop any subscription. Otherwise subscribe the socket to
   the document with that role, send the role message, then serve the sync
   pages from storage exactly like `relayStoreMessage`.
4. Any other kind on a document the socket is not subscribed to:
   `INVALID_MESSAGE` ("Connect to the document before uploading").
5. `syncBack`/`update` with a role below `editor`: `FORBIDDEN`. Otherwise
   append in one storage transaction, which also notes the socket's subject
   as the sender of the rows it adds ([authors](#authors)), acknowledge with
   the stored vector, and when rows were inserted broadcast an `update`
   (request ID 0) to every other socket subscribed to the document, or
   watching one of its ancestors, once per socket. The frames are encoded
   once per envelope, in bounded chunks when the rows do not fit one frame
   of that envelope ("Bounds, encoding and lifecycle" in `PROTOCOL.md`). A
   socket that cannot take them is closed (the local server closes one whose
   frame Bun dropped with 1013): its client reconnects, and its download
   brings the rows.

Storage conflicts answer `CONFLICT`, actor overflow `LIMIT_EXCEEDED`.

### Text frames

```text
server → client  {"type":"welcome","server":{"backend":string,"id":string,"location"?:string},"presence"?:true,"subtrees"?:true,"watch"?:true,"authors"?:true,"subject"?:string}
server → client  {"type":"role","docId":string,"role":"reader"|"editor"|"owner"|null}
client → server  {"type":"unsubscribe","docId":string}
client → server  {"type":"watch","docId":string}
client → server  {"type":"unwatch","docId":string}
client → server  {"type":"actors","docId":string,"actors":[actor…]}
server → client  {"type":"actors","docId":string,"refused":[actor…]}
client → server  {"type":"ping"}      exactly these bytes
server → client  {"type":"pong"}      exactly these bytes
```

`welcome` is the first frame of every socket. It names who answers, for
debugging only: clients never route on it. `backend` names the host
(`cloudflare`, `local`); `id` identifies the instance (the Durable Object ID on
Cloudflare), so a new value means a new instance; `location` is where the
socket was accepted (the Cloudflare colo). `presence: true` says the server
relays [presence frames](#presence); a client never sends them otherwise.
`subject` is the subject of the socket's token, and `authors: true` says the
server binds actors to accounts; a client never sends `actors` otherwise.
Clients ignore unknown fields.

`actors` declares up to 1,024 actors (integers from 65536) that the client
created itself, before it uploads rows of them to `docId`; it never names
the actors of rows it relays. The server binds each to the socket's subject
unless another subject has it ([authors](#authors)), and answers only with
those another subject has. From a session that cannot write `docId` the
message is ignored, without an answer. Rows of a refused actor are stored
all the same. The message is processed in order with the frames of its
socket, so it needs no answer before the upload, and a refusal sent before
a `connect` precedes its sync response.

The reference client declares the actor its page leased before each
`connect`, so that it knows of a refusal before it writes, and every actor
of its own once per session of a document, when it first uploads its rows.
A refused actor is not written under again: the pulse takes another actor
for its next write, and reports a `FORBIDDEN` error.

The reference client keeps one account per connector: once a welcome has
named a subject, a socket whose welcome names another is closed with a
`FORBIDDEN` error that is not retried. It also refuses to open a document,
or to prefetch one, for a pulse whose scope has an `identity` other than the
welcome's subject.

The role message precedes the sync of every `connect`. After a grant change,
the root recomputes the role of every subscription of the affected subject (all
subjects for `*`). A changed role sends a role message; a lost role sends
`null`, then an error frame `FORBIDDEN` with request ID 0, and drops the
subscription. Any other text frame closes the socket with 1008.

`ping` checks the socket, not a document: the server answers `pong` at once,
without touching the root, its subscriptions or its storage. The strings are
fixed so a Cloudflare Durable Object answers through
`setWebSocketAutoResponse`, without waking up or billing duration. The
reference client pings when it
needs a socket that may be dead: before sending on a socket that received
nothing for `heartbeat.staleMs` (5 s), when the page becomes visible or focused
(stale sockets), and when the network comes back (all sockets). It also pings
sockets silent for `heartbeat.intervalMs` (2 s, or never with `false`) for
passive readers, but only while its `activity` says someone may be there
(the page's shared one by default, or `createUserActivity()`): user input within
`activeMs` (5 min, or `unfocusedMs`, 30 s, while the window does not have
focus), the page not reported hidden, and no `userActivity.set(false)` from a
native signal. Input is the signal every webview
reports; visibility only narrows it (WebView2 in Tauri never reports a hidden
page). A page left open sends nothing, so the root can sleep; its first input, focus, `pageshow`, `resume` or edit checks silent
sockets again. A timer that fires late means the process was suspended: every
socket is checked on resume, present or not. With no frame within `heartbeat.timeoutMs` (5 s) after a ping,
it closes the socket and its pulses reconnect.

A subscription ends with `unsubscribe`, a revocation, or the socket. The
reference client sends `unsubscribe` when a pulse's connection closes and
closes an idle socket after `lingerMs`.

`watch` and `unwatch` subscribe a socket to live broadcast frames (`update`,
request ID 0) for newly created or edited descendants (`docId/…`) beneath
`docId` that the socket is not yet subscribed to, provided the server advertised
`watch: true` in its welcome and the socket has access to both `docId` and the
descendant. Watches survive hibernation in the socket attachment (overflowing to
`pulsify_cloud_watches`) and are removed on `unwatch`, deletion, grant
revocation, or socket close. The reference client sends `watch` for open parent
pulses loaded with `subPulses: true` and buffers pushed descendant rows so that
when the parent update carrying the new child ID arrives, the child is already
hydrated with its initial data before parent subscribers run.

## Presence

Presence is a capability: a backend that relays it says `presence: true` in
its welcome, and the conformance suite checks it only then. The Cloudflare
backend does.

Presence frames (kind 7 of [PROTOCOL.md](PROTOCOL.md#presence-kind-7)) follow
the subscriptions of the socket, not the socket itself:

- **Who may send.** A socket subscribed to the document with any role,
  readers included. Without a subscription the frame is dropped silently: the
  client has already received its `FORBIDDEN`.
- **Peer number.** One per socket, the same for every document of the root,
  derived from the connection ID so that it survives hibernation and is still
  known after the socket is gone.
- **Subject.** The subject of the socket's token, set by the root on every
  forwarded frame.
- **Recipients.** The other sockets subscribed to the document that have
  sent a presence frame themselves. The host remembers that with the socket
  (its attachment on Cloudflare), so it also survives hibernation.
- **Departures.** `unsubscribe`, a lost role, a closed socket, and a
  subscription found without its socket when the root wakes up each send a
  leave for that document to the remaining presence sockets.
- **Nothing is stored**, and a root keeps no presence in memory either: a
  newcomer's join is forwarded and the peers answer it themselves.
- **Rate.** Frames beyond 200 per socket and second are dropped.

A client's leave, or a presence frame that does not decode, closes the socket
with 1008 like any other invalid frame.

## Storage

Patch rows use the Pulsify stores of [STORAGE.md](STORAGE.md) unchanged.

**Compaction while asleep.** A document keeps one row per update that keeps
its history, which a client loading it would all read. When the last socket of a root closes, the
object sets an alarm 60 seconds later (`COMPACT_AFTER_MS`; the
`PULSIFY_COMPACT_AFTER_MS` variable overrides it). If a socket is connected
when the alarm fires, nothing happens: the next time the last one closes sets
it again. Otherwise the root [packs](STORAGE.md#compaction) the history of its
documents, at most 4096 stored rows per step, and sets the alarm 10 ms later
while work remains, so that a connection is never kept waiting behind a long
compaction. Runs of fewer than 64 unpacked rows of one actor are left alone.
Clients see no difference: frames are those of an uncompacted root. `rows` in
the usage of a root counts stored rows, so it drops after a compaction. The
alarm is the only one the object uses. Backends built on `CloudRootStorage`
schedule `compact()` themselves; the core never does.

**Expiring roots.** `PUT …/expire` (`cloud.expire(root, { idleMs })`) stores
a lifetime in the root, from 60,000 ms to 30 days, which a later call replaces.
On Cloudflare the last socket's close then sets the alarm `idleMs` later
instead of `COMPACT_AFTER_MS`, and so does the call itself when no socket is
open. When the alarm finds no socket, the object deletes all of its storage,
tombstone included, instead of compacting; the hosted service also tells the
project that the root holds no bytes. A later request to the root finds an
empty root without grants, so clients get `FORBIDDEN`, and its ID can be
granted and used again. The same alarm wipes a root that holds no document
rows, grants or tombstones, such as the empty database a request to an expired
root leaves behind: there is nothing to lose. `CloudRootStorage.expiry` and `setExpiry` are optional:
a backend without them answers `BAD_REQUEST`, and one that stores the lifetime
schedules the erasure itself, as it does compaction.

One SQLite database per root (Durable Object storage) holds the SQLite patch
schema, `pulsify_cloud_grants(subject, prefix, role)`,
`pulsify_cloud_subscriptions(connection, doc_id, role)` and the two tables of
[authors](#authors). `CloudRootStorage.receivedFrom(subject)` is the patch
store as one account writes it: `SqlitePatchStore.append(rows, added)` calls
`added` inside its transaction with the rows that were not held before.

A hibernated object loses its memory while its sockets stay open, so
subscriptions are kept with their socket: its attachment holds the connection
ID, root, subject, envelope and the role of every document it is subscribed
to. Subscribing, unsubscribing and closing a socket therefore write nothing. An
attachment is limited to 16,384 serialized bytes: a subscription that does not
fit is written to `pulsify_cloud_subscriptions` instead, and stays there until
it ends. On wake-up the root reads both; rows of sockets that no longer exist
are deleted.

A Cloudflare Worker forwards to the object named after the root (optionally in
`PULSIFY_JURISDICTION`) with internal headers `x-pulsify-root`,
`x-pulsify-action`, `x-pulsify-envelope` and `x-pulsify-caller`
(`admin` or `user:<percent-encoded subject>`), after removing the credential.
Objects are reachable only through the binding and trust these headers.

## Versioning

A breaking change to routes, subprotocols, control messages or grant semantics
increments the session protocol (`pulsify-cloud.2.*`) and Pulsify's major
version. Changes to the frames themselves follow [PROTOCOL.md](PROTOCOL.md).
Pulsify 16 added authors (the `actors` and `authors` routes, the `actors`
text frames and the `authors` and `subject` fields of the welcome) and live
descendant watches (the `watch` and `unwatch` text frames and the `watch` field
of the welcome). Both are announced by the welcome, so the session protocol is
unchanged.

### Initial subtree prefetch

A welcome with `subtrees:true` advertises streamed initial data fetches. A client
may send `{type:"fetch",docId,requestId,descendants,vectors}` over its root's
socket, where `vectors` is an array of `[docId,versionVector]` and request IDs
are in the reserved range `[2^52, 2^53-1]`. Ordinary per-document sync requests
use lower IDs. Control messages are bounded to 64 KiB. Vectors are optional
bandwidth hints: the connector omits excess hints to fit that control message,
and the server sends complete history for documents without a hint.

The server sends role messages and ordinary binary sync frames carrying that
request ID, then `{type:"fetched",requestId,complete}`. A single request fetches
one document (`descendants:false`) or its ID-prefix subtree (`true`), without
parents or siblings. There is no total document or byte cutoff. The server
pages through document IDs internally, with 128 IDs per storage query, and
sends ordinary bounded binary frames. Transport windows target 64 frames or
1 MiB (one valid protocol frame may exceed that byte target). Before sending
the next window it sends `{type:"fetch-batch",requestId,batch}` and waits for
`{type:"fetch-ack",requestId,batch}`. These acknowledgements apply flow control
to the same request; the client never has to request another page.

Other reads, writes, deletions and grant changes can run between windows.
Authorization and tombstones are rechecked before sending more data. A child
deleted halfway through a document is reported with a `NOT_FOUND` frame for
that child, and its buffered rows are discarded without retiring its parent.
Deleting the requested document or revoking access terminates the fetch.
`{type:"cancel-fetch",requestId}` or disconnecting releases pending work.
The server stops a transfer whose window remains unacknowledged for 30 seconds.
The connector's `timeoutMs` is an inactivity timeout during transfer, not a
limit on its total duration. There is no cross-document transaction guarantee;
each document keeps its own causal vector.

The cloud connector exposes `prefetch(docId,{descendants,vectors})`, returning
`{documents,complete:true}` after the whole fetch succeeds; interruptions reject
instead of silently returning a truncated result. This collecting API retains
the returned rows in client memory. Server reads and response construction still
buffer one document's missing history at a time; a bounded transport window is
not a bound on the size of an individual document in memory.
`loadPulse` uses it automatically for cold eager subtree
loading, applies cached rows only to references it actually visits and falls
back to ordinary loads for out-of-prefix documents and old servers.
Unreferenced descendants may be prefetched but are not instantiated. Explicit
per-document connects install subscriptions and retrieve writes made after
prefetch. Role listeners notify when a role changes, including its first value.

Local cache presence is checked first so a cached document stays available offline.
Connectors without a cache-presence capability retain the ordinary local-first path.

Cloud deletion is an authorized management operation. Directly marking a local
store deleted does not issue a cloud deletion request; apps queue offline
management actions themselves and submit them when connectivity returns.
