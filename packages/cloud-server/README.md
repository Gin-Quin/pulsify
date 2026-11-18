# pulsify-cloud-server

The server of Pulsify Cloud, a managed CRDT database for Pulsify documents.
Apps connect to it with the [`pulsify-cloud`](../cloud/README.md) client.

- **Automatic scaling:** one isolated actor per root document (namespace).
- **Global distribution:** each root lives near its first user.
- **Pay as you go:** idle sockets hibernate.
- **Built-in authentication:** identity tokens, per-root grant tables, live revocation.

A document belongs to the root before its first `/` (`toto/tata` belongs to
`toto`). A client opens **one WebSocket per user and root** and subscribes to
exactly the documents it loads: the root, one sub-document, everything, or a
sub-document with its children.

| Import | Contents |
| --- | --- |
| `pulsify-cloud-server` | `routeCloudRequest` gateway, `CloudRoot` state machine, storage, credentials |
| [`pulsify-cloud-server/cloudflare`](cloudflare/README.md) | Worker + one Durable Object per root, SQLite storage |
| `pulsify-cloud-server/local` | The same server on your machine, one SQLite file per root, and the `pulsify dev` command |

## Local server

```sh
bun add -d pulsify-cloud-server
bun run pulsify dev        # --port 3345 --host 127.0.0.1 --dir .pulsify
```

It prints the three values your app reads from the dashboard in production:

```sh
# .env.development
PULSIFY_URL=http://127.0.0.1:3345/dev
PULSIFY_TOKEN_SECRET=pulsify-dev-token-secret-not-for-production
PULSIFY_API_KEY=pk_pulsify-dev-api-key-not-for-production
```

Authentication works as in the cloud: your backend signs user tokens with the
token secret and manages grants with the API key. The development secrets are
the same for everyone and never change, so they can be committed; they protect
nothing, and the server only listens on your machine. To use your own, of at
least 32 characters each:

```sh
PULSIFY_TOKEN_SECRET=… PULSIFY_API_KEY=… bun run pulsify dev
```

The URL ends with a project name, as on the hosted service. Any other name
than `dev` is another project, with its own roots.

The gateway and the root are those of the hosted service; only the storage
differs. Each root is one SQLite file, `.pulsify/<project>/<root>.sqlite`,
which you can open, copy or delete while the server is stopped. Roots compact
and expire as in the cloud. Plans are not enforced. It runs on Bun only.

```ts
import { startLocalCloud, createLocalCloud } from "pulsify-cloud-server/local";

const server = startLocalCloud({ directory: ".pulsify", port: 3345, secrets });
server.url;    // "http://127.0.0.1:3345": a project is `${server.url}/dev`
server.stop();

// Or mount it in your own Bun server.
const cloud = createLocalCloud({ directory: ".pulsify", secrets });
Bun.serve({ fetch: cloud.fetch, websocket: cloud.websocket });
```

## Building a backend

- `routeCloudRequest(request, secrets)`: the stateless gateway (routing,
  credentials, envelope negotiation).
- `CloudRoot`: the state machine of one root. Give it a `CloudRootStorage`
  (`SqliteCloudStorage` works with any `SqliteConnection`) and the root's
  sockets; feed it socket messages and management requests. It serializes
  every event, like a Durable Object.
- Subscriptions: a `CloudPeer` keeps them with its socket
  (`keepSubscriptions()`, the socket attachment on Cloudflare) and gives them
  back (`subscriptions`) to a root that wakes up. What it refuses to keep goes
  to `CloudRootStorage`. A host that never evicts a root can keep nothing.
- Presence: `CloudRoot` relays it and stores nothing. A `CloudPeer` says
  whether its client uses presence (`presence`) and remembers it for the life
  of the socket (`usePresence()`), in the socket attachment on Cloudflare.
  Send `welcomeMessage(server, { presence: true })` so clients know.
- Metering: a `CloudMeter` counts and limits what a root serves, such as the
  plans of the hosted service. A host calls it when a socket asks to open
  (`connect`), a management request arrives (`request`), a client sends a
  binary frame (`frame`) and a socket closes or the root is erased (`settle`),
  each time with the root's size. A meter written against it runs on every
  host.

[`local/source/index.ts`](local/source/index.ts) is a complete backend on Bun:
the local server. Backends implement the [cloud protocol](../../docs/CLOUD.md)
and pass the same conformance suite:

```sh
bun test packages/cloud-server                    # the local server + unit tests
bun run test:cloud --backend cloudflare           # workerd, real Durable Objects
```

## License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE.md)
(`FSL-1.1-ALv2`). You may use, modify and redistribute this software for any
purpose except a competing use: offering it, or a substitute for it, as a
commercial product or service. Each version becomes available under Apache 2.0
two years after its release.
