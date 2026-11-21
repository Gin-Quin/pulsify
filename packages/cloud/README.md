# pulsify-cloud

The client of [Pulsify Cloud](https://www.npmjs.com/package/pulsify-cloud-server):
a connector with one WebSocket per root, the page's user activity, the management API
client and identity tokens for your backend.

## Client

```ts
import { createCloudConnector, createCloudClient, userActivity } from "pulsify-cloud";

// One socket per root, multiplexing every loaded document of that root.
const cloud = createCloudConnector({
  url: "https://pulsify.example.com",
  token: () => fetch("/api/pulsify-token").then((response) => response.text()),
  // envelope: 2, lingerMs: 5_000,
  // heartbeat: { staleMs: 5_000, timeoutMs: 5_000, intervalMs: 2_000 },
  // activity: createUserActivity({ activeMs: 300_000, unfocusedMs: 30_000 }), // default: the shared `userActivity`
  // createSocket: (url, protocols) => new WebSocket(url, protocols)
});
cloud.roleOf("alice/notes/n1");          // "reader" | "editor" | "owner" | null | undefined
cloud.onRole((docId, role) => {});       // on subscribe and on every grant change

// One connection per root, to the instance that hosts it.
cloud.connections;                       // [{ root, state, server, envelope, documents, latencyMs, error }]
cloud.onConnection((connection) => {     // current ones, then each new one
  connection.on("server", ({ backend, id, location }) => {}); // also state, ping, pong, timeout, suspended, role
});

// Presence (joinPresence from pulsify-core) needs nothing here: the server
// relays it, and peer.subject is the subject of each peer's token.

// The window, shared by every connector: background pings stop while nobody is there.
userActivity.state;                      // { present, reason, visible, focused, away, lastActivity }
userActivity.on("change", (state) => {}); // also "return"
userActivity.set(false);                 // native signal: window minimized, app in background

// Management API: the API key on your servers, or a user token for owners.
const access = createCloudClient({ url, credential: process.env.PULSIFY_API_KEY! });
await access.grant({ subject: "bob", prefix: "alice/notes/n1", role: "editor" });
await access.grants("alice", { subject: "bob" });
await access.revoke({ subject: "bob", prefix: "alice/notes/n1" });
await access.usage("alice");             // { root, documents, rows, bytes, connections }
await access.deleteDocument("alice/notes/n1"); // erases it, its sub-documents and their grants
await access.expire("room-42", { idleMs: 10 * 60_000 }); // erases the root ten minutes after its last socket

// Snapshots: copies of a document kept by the server, with their time and author.
const saved = await access.snapshot("alice/notes/n1", { label: "Sent" }); // an editor
await access.snapshots("alice/notes/n1", { since: lastWeek }); // a reader: [{ id, time, label, subject, version }]
const old = await access.loadSnapshot(Note, "alice/notes/n1", saved.id); // a read-only pulse
restorePulse(note, old);                       // from pulsify-core: the client writes the restore
destroyPulse(old);
await access.deleteSnapshot("alice/notes/n1", saved.id); // an owner

// Who wrote: the user behind an actor of a document's history.
await access.actorSubject("alice/notes/n1", actor);       // "bob", or undefined
```

A snapshot is made by the server from the rows it holds, so take it once the
pulse is `synced`. In a browser, give `createCloudClient` the user's token as
its credential: an editor creates snapshots, a reader lists and opens them, an
owner erases them. Opening one applies the migrations added since it was made.

## Who wrote a document

A document's history names the *actor* of every transaction: a number a page
or a device writes under. Pulsify Cloud knows which user is behind it. When
a client first uploads writes of an actor it created, the root binds that
actor to the subject of the connection's token, for good: one actor has one
user. `actorSubject` asks the root.

```ts
import { getPulseHistory } from "pulsify-core";
import { createCloudClient } from "pulsify-cloud";

const cloud = createCloudClient({ url, credential: token }); // a reader of the document, or the API key

for (const version of getPulseHistory(invoice, "total")) {
  // The user the actor belongs to: the `subject` you signed, or undefined.
  const userId = await cloud.actorSubject(invoice.id, version.actor);
  console.log(version.value, userId ?? "unknown");
}
```

`actorSubject(docId, actor)` resolves to the subject of your token for that
user, or to `undefined` for an actor no account has claimed: nothing is
guessed. A reader of `docId` can ask about the actors that wrote `docId`; the
API key about any actor of the root.

It answers whose the actor is. That is the author of a write as long as
only that user wrote under the actor, which holds for your own clients when
each account has [its own scope](#one-scope-per-account), and which a
dishonest editor can break: nothing stops it from writing under someone
else's actor. `authors` tells such writes apart.

That is who owns the actor. A client also uploads writes it did not make,
those another replica gave it offline or through another connector, so the
root also keeps which account sent each write. `authors` reads everything
for one document, in one request:

```ts
const authors = await cloud.authors(invoice.id);
for (const version of getPulseHistory(invoice, "total")) {
  const { subject, receivedFrom, verified } = authors.of(version);
  // subject:      the user of the actor, as actorSubject answers
  // receivedFrom: the user whose connection sent this write to the server
  // verified:     both are one user, who claimed the actor and sent the write itself
}
authors.actors; // Map of actor → subject, for the document
```

Show `subject` as the author when `verified` is true. When it is false the
server cannot tell: the write was relayed by `receivedFrom`, or its actor was
never claimed, or it was stored before version 16. A version with
`migration: true` was written by Pulsify on the device of that user, who
edited nothing. Writes are not signed, so this is as strong as your tokens:
nobody can make a write appear as *verified* for another user, and an editor
can take credit only for an actor that no one has claimed yet, in any
document of the root.

### One scope per account

Where the account can change on a device (a shared browser profile, a
sign-out followed by another sign-in), give each account its own scope and
connector. It is what keeps two accounts from writing under one actor, and
what lets a page upload, as its own, what an earlier page of the same
account wrote offline:

```ts
import { createPulseScope, setDefaultPulseOptions } from "pulsify-core";

// On sign-in. `identity` is the subject you sign into that user's tokens.
const cloud = createCloudConnector({ url, token: fetchToken });
setDefaultPulseOptions({
  scope: createPulseScope({ identity: user.id }),
  connectors: [cloud, local],
});
// On sign-out: cloud.close(), and a new scope and connector for the next user.
// Never erase the local store: writes not uploaded yet are still in it.
```

A connector serves one account: it refuses a socket whose token belongs to
another subject than its first one, and a pulse whose scope has another
`identity` than the token.

Without an `identity`, the accounts of a profile share its actors. The
server then refuses the second account an actor that the first one has, and
the client stops writing under it and reports a `FORBIDDEN` error to
`onError`; what a page wrote under it before it knew, a transaction or two,
reads as the first account's actor, unverified. And a write made offline is
uploaded by a later page as a relayed one, unverified, since nothing says it
was this account's.

## Backend

```ts
import { signCloudToken } from "pulsify-cloud";

const token = await signCloudToken({ subject: user.id }, process.env.PULSIFY_TOKEN_SECRET!, {
  expiresIn: "15m",
});
```

Tokens identify a user; rights live in each root's grant table (`reader`,
`editor`, `owner`; subject `*` for every authenticated user). Grants cover their
prefix and everything below it, and the strongest one wins.

## Protocol

`peekFrameHeader`, `CLOUD_SUBPROTOCOLS`, control message parsers, `roleFor`,
`rootOf`, `covers` and `parseGrant` implement the cloud protocol on both sides.

## License

Apache-2.0

`loadPulse` eagerly prefetches an ID subtree in one data request when the server
advertises support, then subscribes to the referenced documents individually.
While a parent pulse stays open with `subPulses: true` and the server advertises
`watch: true`, the connector also watches its prefix so newly created
descendants arrive with their initial data ahead of the parent update.
Use `subPulses:false` to load only the requested document, without ancestors or
live descendant pushes.
The lower-level `cloud.prefetch(docId,{descendants:true,vectors:[]})` returns
`{documents,complete:true}` after streaming the whole result, with no total
document or byte cutoff. Internal transport acknowledgements pace the same
request; the client does not request additional pages. Deleted
prefixes are excluded. Deleting a document permanently retires its ID and all
descendant IDs. Local unsynced operations are retained for recovery, not uploaded
again. Use new IDs for recovered documents.
