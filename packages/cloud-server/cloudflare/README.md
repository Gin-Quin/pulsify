# @pulsify/cloud-server/cloudflare

Pulsify Cloud on Cloudflare: a Worker authenticates and routes, and **one
Durable Object per root** stores the root's documents, grants and socket
subscriptions in its SQLite database. Sockets use the hibernation API.

```ts
// worker.ts
export { PulsifyCloudRoot, cloudWorker as default } from "@pulsify/cloud-server/cloudflare";
```

```jsonc
// wrangler.jsonc
{
  "name": "pulsify-cloud",
  "main": "worker.ts",
  "compatibility_date": "2026-11-05",
  "durable_objects": {
    "bindings": [{ "name": "PULSIFY_ROOTS", "class_name": "PulsifyCloudRoot" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["PulsifyCloudRoot"] }]
}
```

```sh
openssl rand -base64 48 | bunx wrangler secret put PULSIFY_TOKEN_SECRET
openssl rand -base64 48 | bunx wrangler secret put PULSIFY_API_KEY
bunx wrangler deploy
```

`handleCloudRequest(request, env)` mounts the routes in a Worker that also
serves other paths. Set `PULSIFY_JURISDICTION` (for example `eu`) before the
first deployment to keep every root in a jurisdiction.

Test against real Durable Objects with `bun run test:cloud --backend cloudflare`.
