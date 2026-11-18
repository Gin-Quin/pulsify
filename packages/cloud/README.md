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
```

A snapshot is made by the server from the rows it holds, so take it once the
pulse is `synced`. In a browser, give `createCloudClient` the user's token as
its credential: an editor creates snapshots, a reader lists and opens them, an
owner erases them. Opening one applies the migrations added since it was made.

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
Use `subPulses:false` to load only the requested document, without ancestors.
The lower-level `cloud.prefetch(docId,{descendants:true,vectors:[]})` returns
`{documents,complete:true}` after streaming the whole result, with no total
document or byte cutoff. Internal transport acknowledgements pace the same
request; the client does not request additional pages. Deleted
prefixes are excluded. Deleting a document permanently retires its ID and all
descendant IDs. Local unsynced operations are retained for recovery, not uploaded
again. Use new IDs for recovered documents.
