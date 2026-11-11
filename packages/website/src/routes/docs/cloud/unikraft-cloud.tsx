import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { SequenceDiagram } from "~/components/SequenceDiagram";

const layout = `instance (Unikraft Cloud, base-compat runtime)
├── pulsify-cloud-entrypoint     starts both processes, stops the instance if one exits
├── postgres                     Unix socket /var/run/postgresql only, data in /data/postgres
└── pulsify-cloud-server (Rust)  :8080, gateway + one actor per root
volume /data                     survives restarts and redeployments`;

const build = `# From a clone of the Pulsify repository
unikraft login
bun run cloud:unikraft -- --output <my-org>/pulsify-cloud:latest`;

const run = `unikraft volume create --set metro=fra --set name=pulsify-data --set size=1Gi

unikraft run --metro fra \\
  -m 1G \\
  -p 443:8080/tls+http \\
  --scale-to-zero policy=idle,cooldown-time=5000,stateful=true \\
  -e PULSIFY_TOKEN_SECRET="$(openssl rand -base64 48)" \\
  -e PULSIFY_API_KEY="$(openssl rand -base64 48)" \\
  --volume pulsify-data:/data \\
  --image <my-org>/pulsify-cloud:latest
# fqdn: young-thunder-fbafrsxj.fra.unikraft.app  →  PULSIFY_URL=https://…`;

const local = `bun run cloud:unikraft --docker pulsify-cloud

docker run --rm -p 8080:8080 \\
  -e PULSIFY_TOKEN_SECRET="a local secret of at least thirty-two characters" \\
  -e PULSIFY_API_KEY="a local api key of at least thirty-two characters" \\
  -v pulsify-data:/data \\
  pulsify-cloud

curl http://localhost:8080/v1/health   # {"ok":true}`;

const schema = `import { UNIKRAFT_CLOUD_POSTGRES_SCHEMA } from "@pulsify/cloud-server/unikraft-cloud";

// pulsify_op_rows, pulsify_doc_clocks, pulsify_append(): the self-hosted patch schema
// pulsify_cloud_grants(root, subject, prefix, role): the grant tables of every root`;

const test = `bun run test:cloud --backend unikraft                       # cargo build + local PostgreSQL
bun run test:cloud --backend unikraft --image pulsify-cloud  # the Docker image`;

export default function UnikraftCloudBackend() {
	return (
		<>
			<Title>Unikraft Cloud backend · Docs</Title>
			<h1>Unikraft Cloud backend</h1>
			<p>
				The Unikraft Cloud backend serves the same API as the Cloudflare one
				from a single image: a <strong>Rust server</strong> replaces the Worker
				and the Durable Objects, and <strong>PostgreSQL</strong> replaces their
				SQLite. Clients cannot tell the difference.
			</p>
			<SequenceDiagram
				caption="Inside one instance: the server is the only process reachable from the network."
				actors={["Client", "Rust server", "Actor alice", "PostgreSQL"]}
				steps={[
					{ from: 0, to: 1, label: "upgrade /v1/roots/alice" },
					{ from: 1, to: 1, label: "verify token" },
					{ from: 1, to: 2, label: "socket for subject" },
					{ from: 0, to: 2, label: "connect alice/notes/n1" },
					{ from: 2, to: 3, label: "missing rows (Unix socket)" },
					{ from: 2, to: 0, label: "role + sync", reply: true },
					{ from: 0, to: 2, label: "update" },
					{ from: 2, to: 3, label: "pulsify_append()" },
					{
						from: 2,
						to: 0,
						label: "ack, broadcast to subscribers",
						reply: true,
					},
				]}
			/>

			<h2>One instance, two processes</h2>
			<CodeBlock title="image layout" code={layout} />
			<p>PostgreSQL runs beside the server rather than on its own instance:</p>
			<ul>
				<li>
					<strong>Nothing to secure between them.</strong> PostgreSQL listens on
					a Unix socket only: no port, no password, no TLS.
				</li>
				<li>
					<strong>They sleep and wake together.</strong> With stateful
					scale-to-zero, one snapshot holds the server and the database, so a
					resumed instance answers its first frame without a database
					reconnection.
				</li>
				<li>
					<strong>One thing to deploy.</strong> One image, one volume, one
					instance per deployment.
				</li>
			</ul>
			<p>
				The trade-off is vertical scaling: one instance serves all its roots.
				Each root is still an isolated actor that processes its events in order,
				exactly like a Durable Object, so splitting roots across instances later
				changes no semantics.
			</p>

			<h2>1. Build the image</h2>
			<p>
				The server depends on the protocol crate of this repository. The script
				stages a self-contained build context (Kraftfile, Dockerfile, server and
				protocol sources) and runs <code>unikraft build</code> on it.
			</p>
			<CodeBlock title="terminal" code={build} />

			<h2>2. Create a volume and run</h2>
			<p>
				Keep the database on a volume mounted at <code>/data</code>. The{" "}
				<code>idle</code> policy suspends the instance between frames, even with
				sockets open; <code>stateful=true</code> resumes it from memory. Client
				heartbeats wake it briefly: pings go out when a silent socket is needed,
				plus one per silent socket every 2 s while someone uses the page. Tabs
				left open send nothing, so the instance sleeps. A short{" "}
				<code>heartbeat.intervalMs</code> or a long{" "}
				<code>heartbeat.activeMs</code> keeps it awake longer.
			</p>
			<CodeBlock title="terminal" code={run} />
			<p>
				Store both secrets: your backend needs <code>PULSIFY_TOKEN_SECRET</code>{" "}
				to sign tokens and <code>PULSIFY_API_KEY</code> to grant rights. Then
				follow the <a href="/docs/cloud/tutorial">tutorial</a> with the instance
				URL.
			</p>

			<h2>Run it locally</h2>
			<p>The same image runs in Docker:</p>
			<CodeBlock title="terminal" code={local} />

			<h2>Configuration</h2>
			<table>
				<thead>
					<tr>
						<th>Variable</th>
						<th>Default</th>
						<th>Meaning</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>
							<code>PULSIFY_TOKEN_SECRET</code>
						</td>
						<td>required</td>
						<td>HS256 secret shared with your backend, 32+ characters.</td>
					</tr>
					<tr>
						<td>
							<code>PULSIFY_API_KEY</code>
						</td>
						<td>required</td>
						<td>Management key, 32+ characters.</td>
					</tr>
					<tr>
						<td>
							<code>PORT</code>
						</td>
						<td>
							<code>8080</code>
						</td>
						<td>Port of the Rust server.</td>
					</tr>
					<tr>
						<td>
							<code>PGDATA</code>
						</td>
						<td>
							<code>/data/postgres</code>
						</td>
						<td>Database directory; initialized on first boot.</td>
					</tr>
					<tr>
						<td>
							<code>DATABASE_URL</code>
						</td>
						<td>the local Unix socket</td>
						<td>Point the server to another PostgreSQL instead.</td>
					</tr>
					<tr>
						<td>
							<code>PULSIFY_POOL_SIZE</code>
						</td>
						<td>
							<code>16</code>
						</td>
						<td>PostgreSQL connections of the server.</td>
					</tr>
					<tr>
						<td>
							<code>PULSIFY_SHARED_BUFFERS</code>
						</td>
						<td>
							<code>64MB</code>
						</td>
						<td>
							PostgreSQL <code>shared_buffers</code>; raise it with memory.
						</td>
					</tr>
				</tbody>
			</table>

			<h2>How it maps to Cloudflare</h2>
			<table>
				<thead>
					<tr>
						<th>Cloudflare</th>
						<th>Unikraft Cloud</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>Worker: routing, tokens, API key</td>
						<td>Rust server, same routes and errors</td>
					</tr>
					<tr>
						<td>Durable Object per root</td>
						<td>
							Actor per root in the server, alive while a socket or request uses
							it
						</td>
					</tr>
					<tr>
						<td>SQLite per root</td>
						<td>
							One PostgreSQL database; grants are keyed by root, rows by
							document ID
						</td>
					</tr>
					<tr>
						<td>Subscription table for hibernation</td>
						<td>Subscriptions in memory: the process keeps its sockets</td>
					</tr>
					<tr>
						<td>Hibernation</td>
						<td>Stateful scale-to-zero</td>
					</tr>
				</tbody>
			</table>
			<p>
				The schema is the self-hosted PostgreSQL patch schema plus one grant
				table. It is exported for tooling and embedded in the server:
			</p>
			<CodeBlock title="schema.ts" code={schema} />

			<h2>Operations</h2>
			<ul>
				<li>
					<strong>Backups:</strong> the whole state is the volume. Snapshot it,
					or point <code>DATABASE_URL</code> at a managed PostgreSQL if you
					prefer its backups.
				</li>
				<li>
					<strong>Usage:</strong> <code>GET /v1/roots/{"{root}"}/usage</code>{" "}
					with the API key returns documents, rows, bytes and open sockets of a
					root.
				</li>
				<li>
					<strong>Stopping:</strong> the entrypoint stops the server, then
					PostgreSQL, on <code>SIGTERM</code>. If either process dies, the
					instance exits so the platform restarts both.
				</li>
			</ul>
			<Note>
				Run one server per database: each root actor caches its grants, so two
				servers writing the same grant table would not see each other's changes.
				The conformance suite runs against both the binary and the image:
			</Note>
			<CodeBlock title="terminal" code={test} />
		</>
	);
}
