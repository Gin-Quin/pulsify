# pulsify-cloud-server/unikraft-cloud

Pulsify Cloud on [Unikraft Cloud](https://unikraft.com): one image with a
**Rust server** (gateway and one actor per root, replacing the Worker and the
Durable Objects) and **PostgreSQL** (replacing their SQLite), listening only on
a Unix socket. Same routes, tokens, grants and session protocol as Cloudflare.

```text
Kraftfile                           base-compat runtime, rootfs from the Dockerfile
Dockerfile                          context = repository root (or the staged context)
rootfs/usr/local/bin/…-entrypoint   starts PostgreSQL, then the server; exits if either dies
server/                             Rust crate pulsify-cloud-server
server/sql/schema.sql               generated: bun run cloud:schema
```

## Deploy

```sh
bun run cloud:unikraft -- --output <my-org>/pulsify-cloud:latest

unikraft volume create --set metro=fra --set name=pulsify-data --set size=1Gi
unikraft run --metro fra -m 1G -p 443:8080/tls+http \
  --scale-to-zero policy=idle,cooldown-time=5000,stateful=true \
  -e PULSIFY_TOKEN_SECRET=… -e PULSIFY_API_KEY=… \
  --volume pulsify-data:/data \
  --image <my-org>/pulsify-cloud:latest
```

`cloud:unikraft` stages a self-contained build context (the server depends on
`crates/pulsify-protocol`) and runs `unikraft build` on it; `--docker <tag>`
builds the same image with Docker instead.

| Variable | Default |
| --- | --- |
| `PULSIFY_TOKEN_SECRET`, `PULSIFY_API_KEY` | required, 32+ characters |
| `PORT` | `8080` |
| `PGDATA` | `/data/postgres` |
| `DATABASE_URL` | `host=/var/run/postgresql user=postgres dbname=postgres` |
| `PULSIFY_POOL_SIZE` | `16` |
| `PULSIFY_SHARED_BUFFERS` | `64MB` |

The TypeScript export provides `UNIKRAFT_CLOUD_POSTGRES_SCHEMA` (embedded by the
server) and `UNIKRAFT_CLOUD_DEFAULTS`.

```sh
cargo test --manifest-path packages/cloud-server/unikraft-cloud/server/Cargo.toml
bun run test:cloud --backend unikraft                       # binary + local PostgreSQL
bun run test:cloud --backend unikraft --image pulsify-cloud  # Docker image
```
