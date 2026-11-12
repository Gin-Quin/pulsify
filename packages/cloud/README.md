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
```

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
