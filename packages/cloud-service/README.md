# pulsify-cloud-service

The hosted Pulsify Cloud at `https://api.pulsify.cloud`. Private: it is not
published. It wraps `pulsify-cloud-server/cloudflare` with customer projects,
login links, quotas and Polar billing.

```text
/<project>/v1/…     the Pulsify Cloud protocol (docs/CLOUD.md), with the project's secrets and roots
/account/…          the dashboard's API: login links, secrets, checkout, billing portal
/polar/webhook      Polar's customer.state_changed sets a project's plan
/health             { "ok": true }
```

Three Durable Object classes:

- `PulsifyRoot`, one per project and root (`<project>/<root>`): a
  `PulsifyCloudRoot` that counts the frames clients send (presence aside) and
  reports them, with its database size and sockets, to its project every 30
  seconds while active, and on every socket open and close.
- `PulsifyProject`, one per project: secrets, plan, sessions and usage. It
  answers each report: a Free project over 1M messages this month or 1 GB
  refuses uploads (`LIMIT_EXCEEDED`); any project over its plan's live
  connections refuses new sockets. Pro sends `cloud.messages` to Polar every 5
  minutes and `cloud.storage` (GB-days) once a day.
- `PulsifyAccount`, one per email address: its project and its login link.

The Polar products, meters and credits are set up in the Polar dashboard; the
Pro product IDs are in `wrangler.jsonc`.

## Deploy

```sh
bunx wrangler email sending enable pulsify.cloud
bunx wrangler secret put POLAR_ACCESS_TOKEN -c packages/cloud-service/wrangler.jsonc
bunx wrangler secret put POLAR_WEBHOOK_SECRET -c packages/cloud-service/wrangler.jsonc
bun run deploy:service
```

`POLAR_ACCESS_TOKEN` is an organization token with `checkouts:write`,
`customer_sessions:write` and `events:write`, without expiry.

## Test

```sh
bun test packages/cloud-service/tests       # accounts, tenancy, quotas, Polar
bun run test:cloud --backend service        # the conformance suite through a project, in workerd
```
