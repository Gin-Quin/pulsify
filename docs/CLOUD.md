# Pulsify Cloud protocol

Cloud session protocol **1**. It carries the unchanged Pulsify frames described
in [PROTOCOL.md](PROTOCOL.md) (envelopes 1 and 2, operations version 3) and
adds routing, authentication, multiplexing and access control. Every backend
(`pulsify-cloud-server/cloudflare`) implements this document; the conformance
suite in
[`packages/cloud-server/core/tests/conformance.ts`](../packages/cloud-server/core/tests/conformance.ts)
is the executable authority. Run it with
`bun run test:cloud --backend cloudflare`.

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

The `prefix` filter keeps grants whose prefix it covers. Bodies are limited to
64 KiB.

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
   append in one storage transaction, acknowledge with the stored vector, and
   when rows were inserted broadcast an `update` (request ID 0) to every other
   socket subscribed to the document.

Storage conflicts answer `CONFLICT`, actor overflow `LIMIT_EXCEEDED`.

### Text frames

```text
server → client  {"type":"welcome","server":{"backend":string,"id":string,"location"?:string},"presence"?:true}
server → client  {"type":"role","docId":string,"role":"reader"|"editor"|"owner"|null}
client → server  {"type":"unsubscribe","docId":string}
client → server  {"type":"ping"}      exactly these bytes
server → client  {"type":"pong"}      exactly these bytes
```

`welcome` is the first frame of every socket. It names who answers, for
debugging only: clients never route on it. `backend` names the host
(`cloudflare`); `id` identifies the instance (the Durable Object ID on
Cloudflare), so a new value means a new instance; `location` is where the
socket was accepted (the Cloudflare colo). `presence: true` says the server
relays [presence frames](#presence); a client never sends them otherwise.
Clients ignore unknown fields.

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

## Presence

Presence is a capability: a backend that relays it says `presence: true` in
its welcome, and the conformance suite checks it only then. The Cloudflare
backend does; the Unikraft Cloud server does not yet.

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

**Compaction while asleep.** A document keeps one row per update, which a
client loading it would all read. When the last socket of a root closes, the
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

One SQLite database per root (Durable Object storage) holds the SQLite patch
schema, `pulsify_cloud_grants(subject, prefix, role)` and
`pulsify_cloud_subscriptions(connection, doc_id, role)`.

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
