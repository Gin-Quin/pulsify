# @pulsify/cloud-server

The server of Pulsify Cloud, a managed CRDT database for Pulsify documents.
Apps connect to it with the [`@pulsify/cloud`](../cloud/README.md) client.

- **Automatic scaling:** one isolated actor per root document (namespace).
- **Global distribution:** on Cloudflare, each root lives near its first user.
- **Pay as you go:** hibernating sockets on Cloudflare, scale-to-zero on Unikraft Cloud.
- **Built-in authentication:** identity tokens, per-root grant tables, live revocation.

A document belongs to the root before its first `/` (`toto/tata` belongs to
`toto`). A client opens **one WebSocket per user and root** and subscribes to
exactly the documents it loads: the root, one sub-document, everything, or a
sub-document with its children.

| Import | Contents |
| --- | --- |
| `@pulsify/cloud-server` | `routeCloudRequest` gateway, `CloudRoot` state machine, storage, credentials |
| [`@pulsify/cloud-server/cloudflare`](cloudflare/README.md) | Worker + one Durable Object per root, SQLite storage |
| [`@pulsify/cloud-server/unikraft-cloud`](unikraft-cloud/README.md) | Rust server + PostgreSQL in one Unikraft Cloud image |

## Building a backend

- `routeCloudRequest(request, secrets)`: the stateless gateway (routing,
  credentials, envelope negotiation).
- `CloudRoot`: the state machine of one root. Give it a `CloudRootStorage`
  (`SqliteCloudStorage` works with any `SqliteConnection`) and the root's
  sockets; feed it socket messages and management requests. It serializes
  every event, like a Durable Object.

[`core/tests/host.ts`](core/tests/host.ts) is a complete backend in 100 lines
on Bun. Both backends implement the [cloud protocol](../../docs/CLOUD.md) and
pass the same conformance suite:

```sh
bun test packages/cloud-server                    # in-process backend + unit tests
bun run test:cloud --backend cloudflare           # workerd, real Durable Objects
bun run test:cloud --backend unikraft             # Rust server + local PostgreSQL
bun run test:cloud --backend unikraft --image pulsify-cloud
```

## License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE.md)
(`FSL-1.1-ALv2`). You may use, modify and redistribute this software for any
purpose except a competing use: offering it, or a substitute for it, as a
commercial product or service. Each version becomes available under Apache 2.0
two years after its release.
