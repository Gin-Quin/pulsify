import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { SequenceDiagram } from "~/components/SequenceDiagram";

const install = `bun add pulsify-core pulsify-cloud pulsify-cloud-server
bun add -d wrangler`;

const worker = `// worker.ts
export { PulsifyCloudRoot, cloudWorker as default } from "pulsify-cloud-server/cloudflare";`;

const custom = `// worker.ts, when the Worker also serves other routes
import { handleCloudRequest, type PulsifyCloudEnv } from "pulsify-cloud-server/cloudflare";
export { PulsifyCloudRoot } from "pulsify-cloud-server/cloudflare";

export default {
  async fetch(request: Request, env: PulsifyCloudEnv) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/v1/")) return handleCloudRequest(request, env);
    return new Response("Hello");
  },
};`;

const wrangler = `// wrangler.jsonc
{
  "name": "pulsify-cloud",
  "main": "worker.ts",
  "compatibility_date": "2026-11-05",
  "durable_objects": {
    "bindings": [{ "name": "PULSIFY_ROOTS", "class_name": "PulsifyCloudRoot" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["PulsifyCloudRoot"] }]
  // Optional data residency for every root:
  // "vars": { "PULSIFY_JURISDICTION": "eu" }
}`;

const secrets = `openssl rand -base64 48 | bunx wrangler secret put PULSIFY_TOKEN_SECRET
openssl rand -base64 48 | bunx wrangler secret put PULSIFY_API_KEY
bunx wrangler deploy
# https://pulsify-cloud.<account>.workers.dev  →  your PULSIFY_URL`;

const dev = `# .dev.vars (never commit)
PULSIFY_TOKEN_SECRET="a local secret of at least thirty-two characters"
PULSIFY_API_KEY="a local api key of at least thirty-two characters"

bunx wrangler dev   # http://localhost:8787, Durable Objects and SQLite included`;

const smoke = `curl http://localhost:8787/v1/health
# {"ok":true}
curl -X PUT http://localhost:8787/v1/roots/alice/grants \\
  -H "Authorization: Bearer $PULSIFY_API_KEY" \\
  -d '{"subject":"alice","prefix":"alice","role":"owner"}'`;

const test = `bun run test:cloud --backend cloudflare   # this repository: workerd + conformance suite`;

export default function CloudflareBackend() {
	return (
		<>
			<Title>Cloudflare backend · Docs</Title>
			<h1>Cloudflare backend</h1>
			<p>
				<code>pulsify-cloud-server/cloudflare</code> runs Pulsify Cloud on
				Cloudflare Workers. A stateless Worker authenticates every request;{" "}
				<strong>one Durable Object per root</strong> holds the root's documents,
				grants and sockets in its own SQLite database.
			</p>
			<SequenceDiagram
				caption="The Worker never stores anything; each root's Durable Object owns its data."
				actors={["Client", "Worker", "Object alice", "Object bob"]}
				steps={[
					{ from: 0, to: 1, label: "upgrade /v1/roots/alice" },
					{ from: 1, to: 1, label: "verify token" },
					{ from: 1, to: 2, label: "idFromName(alice)" },
					{ from: 2, to: 0, label: "101, hibernatable socket", reply: true },
					{ from: 0, to: 2, label: "frames of alice/*" },
					{ from: 0, to: 1, label: "upgrade /v1/roots/bob" },
					{ from: 1, to: 3, label: "idFromName(bob)" },
					{ from: 3, to: 0, label: "frames of bob/*", reply: true },
				]}
			/>

			<h2>Why Durable Objects</h2>
			<ul>
				<li>
					<strong>Automatic scaling.</strong> Each root is its own object, so
					capacity grows with the number of roots. There is no shared database
					to size.
				</li>
				<li>
					<strong>Global distribution.</strong> An object is created near the
					first request for its root, which is usually its owner.
				</li>
				<li>
					<strong>Pay as you go.</strong> Sockets use the hibernation API: an
					idle root is evicted from memory while its sockets stay open, and
					wakes up on the next frame. Heartbeat pings are answered by the
					runtime (<code>setWebSocketAutoResponse</code>) without waking it.
				</li>
				<li>
					<strong>Serialized writes.</strong> An object processes one event at a
					time, so appends, acknowledgements and broadcasts of a root are
					ordered without locks.
				</li>
			</ul>

			<h2>1. Install</h2>
			<CodeBlock title="terminal" code={install} />

			<h2>2. Write the Worker</h2>
			<p>Two exports: the Durable Object class and the fetch handler.</p>
			<CodeBlock title="worker.ts" code={worker} />
			<p>Or mount the cloud routes next to your own:</p>
			<CodeBlock title="worker.ts" code={custom} />

			<h2>3. Configure Wrangler</h2>
			<p>
				The binding must be named <code>PULSIFY_ROOTS</code> and the class must
				use SQLite storage (<code>new_sqlite_classes</code>).
			</p>
			<CodeBlock title="wrangler.jsonc" code={wrangler} />

			<h2>4. Set the secrets and deploy</h2>
			<CodeBlock title="terminal" code={secrets} />
			<p>
				Use the same <code>PULSIFY_TOKEN_SECRET</code> in the backend that signs
				tokens. Keep <code>PULSIFY_API_KEY</code> on your servers. Then follow
				the <a href="/docs/cloud/tutorial">tutorial</a> with the Worker URL.
			</p>

			<h2>Local development</h2>
			<CodeBlock title="terminal" code={dev} />
			<CodeBlock title="terminal" code={smoke} />

			<h2>What runs where</h2>
			<table>
				<thead>
					<tr>
						<th>Piece</th>
						<th>Role</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>Worker</td>
						<td>
							Routes <code>/v1/roots/{"{root}"}/…</code>, verifies the token or
							API key, negotiates the envelope, strips the credential and
							forwards to the root's object.
						</td>
					</tr>
					<tr>
						<td>
							<code>PulsifyCloudRoot</code>
						</td>
						<td>
							Wraps <code>CloudRoot</code> from{" "}
							<code>pulsify-cloud-server</code> over the object's SQLite: patch
							rows, the grant table and the subscription table that survives
							hibernation.
						</td>
					</tr>
					<tr>
						<td>Socket attachment</td>
						<td>
							Connection ID, subject and envelope, restored after wake-up.
						</td>
					</tr>
				</tbody>
			</table>
			<p>
				<code>PULSIFY_JURISDICTION</code> places every root in a jurisdiction
				such as <code>eu</code>. Set it before the first deployment: the
				jurisdiction is part of the object ID, so changing it later points every
				root to a new, empty object.
			</p>

			<h2>Limits and costs</h2>
			<ul>
				<li>
					A root is one object: one thread and one SQLite database, with the
					per-object storage limit of your Cloudflare plan. Split very large or
					very busy namespaces into several roots.
				</li>
				<li>
					Cloudflare bills Durable Object requests, duration and storage. Every
					WebSocket message is a request; hibernated sockets add no duration.
				</li>
				<li>
					Frames are limited to 8 MiB by Pulsify; uploads are chunked well below
					that.
				</li>
			</ul>
			<Note>
				This repository runs the full conformance suite against real Durable
				Objects in <code>workerd</code>:
			</Note>
			<CodeBlock title="terminal" code={test} />
		</>
	);
}
