# pulsify-cloud-service

The hosted Pulsify Cloud at `https://api.pulsify.cloud`. Private: it is not
published. It wraps `pulsify-cloud-server/cloudflare` with customer projects,
login links and codes, quotas and Polar billing.

License: [FSL-1.1-ALv2](LICENSE.md), like the cloud server it wraps.

```text
/<project>/v1/…     the Pulsify Cloud protocol (docs/CLOUD.md), with the project's secrets and roots
/account/…          the dashboard's API: login links and codes, secrets, checkout, billing portal, deletion
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
- `PulsifyAccount`, one per email address: its project and its login link and code. A
  code allows 20 wrong attempts per address a day.

`POST /account/delete` erases a Free project: it stops answering at once, its
alarm wipes the roots 25 at a time, then the project, two minutes after the
last root, when no gateway can still route to it. The account is forgotten, so
the address starts a new project at its next sign-in. A Pro project answers
409 until its subscription has ended.

The Polar products, meters and credits are set up in the Polar dashboard; the
Pro product IDs are in `wrangler.jsonc`.

## Develop

`bun run dev:website` starts the website on `http://localhost:3000` and this
service on `http://localhost:8787` (`bun run dev:service` alone), in miniflare:
Durable Objects persist in `packages/cloud-service/.wrangler/`, and login emails
are not sent. Their codes and links print in the terminal, and the code
`444444` signs in any address that asked for a code.

Billing uses the Pulsify organization of the Polar sandbox
(`https://sandbox.polar.sh`), with its own Pro products and meters.
`packages/cloud-service/.dev.vars`, which git ignores, holds its access token
and product IDs:

```sh
POLAR_ACCESS_TOKEN=polar_oat_…
POLAR_WEBHOOK_SECRET=…
POLAR_PRO_MONTHLY=<sandbox product ID>
POLAR_PRO_YEARLY=<sandbox product ID>
```

Without it, everything but checkout and the billing portal works. Polar rejects
checkout emails on domains that cannot receive mail, such as `example.com`.
Polar cannot reach `localhost`: to test the webhook, expose port 8787 through a
tunnel, point a sandbox webhook at `<tunnel>/polar/webhook` and set its secret
in `.dev.vars`.

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
