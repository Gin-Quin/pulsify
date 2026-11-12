import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { SequenceDiagram } from "~/components/SequenceDiagram";

const refresh = `import { createWebSocketConnector } from "pulsify-core";

let token = await fetchToken();
setInterval(async () => (token = await fetchToken()), 10 * 60_000);

const relay = createWebSocketConnector(
  "wss://relay.example.com/sync?doc={docId}",
  // Called for every new session: reconnections and sub-pulses get a fresh token.
  (url, protocols) => new WebSocket(\`\${url}&token=\${token}\`, protocols),
  { protocolVersion: 2 },
);`;

const selfHost = `import { PulseRelay, type RelayPeer } from "pulsify-core";

const relay = new PulseRelay();
type Session = { docId: string; readOnly: boolean; peer?: RelayPeer };

Bun.serve<Session>({
  port: 3000,
  async fetch(request, server) {
    const docId = new URL(request.url).searchParams.get("doc");
    const user = await userFromCookie(request);                          // your auth
    const role = user && docId ? await roleOf(user, docId) : undefined;  // your rules
    if (!docId || !role) return new Response("Forbidden", { status: 403 });
    const data = { docId, readOnly: role !== "editor" };
    return server.upgrade(request, { data }) ? undefined : new Response(null, { status: 400 });
  },
  websocket: {
    open(socket) {
      const { docId, readOnly } = socket.data;
      socket.data.peer = relay.open((bytes) => socket.sendBinary(bytes), { docId, readOnly });
    },
    message(socket, message) {
      if (typeof message === "string") return socket.close(1003);
      socket.data.peer!.receive(new Uint8Array(message));
    },
    close(socket) { socket.data.peer?.close(); },
  },
});`;

const store = `import { relayStoreMessage } from "pulsify-core/protocol";

const { responses } = await relayStoreMessage(store, bytes, { docId, readOnly });`;

export default function Auth() {
	return (
		<>
			<Title>Self-host: authentication · Docs</Title>
			<h1>Self-host: authentication</h1>
			<p>
				Pulsify stores no users and no access lists. Your server decides who may
				open which document, once, before the WebSocket upgrade. After that, a
				session is pinned to one document with one role.
			</p>

			<SequenceDiagram
				caption="Access is checked once, at the upgrade. Frames then flow without further checks."
				actors={["Client", "Your backend", "Relay"]}
				steps={[
					{ from: 0, to: 1, label: "log in (your own auth)" },
					{ from: 1, to: 0, label: "credential", reply: true },
					{ from: 0, to: 2, label: "upgrade ?doc=1234 + credential" },
					{ from: 2, to: 2, label: "check access → role" },
					{ from: 2, to: 0, label: "403, or 101 + session", reply: true },
					{ from: 0, to: 2, label: "binary frames" },
				]}
			/>

			<h2>Roles</h2>
			<table>
				<thead>
					<tr>
						<th>Role</th>
						<th>Connect and download</th>
						<th>Upload changes</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>none</td>
						<td>403 before the upgrade</td>
						<td>—</td>
					</tr>
					<tr>
						<td>
							<code>reader</code>
						</td>
						<td>yes</td>
						<td>
							rejected with <code>FORBIDDEN</code>
						</td>
					</tr>
					<tr>
						<td>
							<code>editor</code>
						</td>
						<td>yes</td>
						<td>yes, including creating the document</td>
					</tr>
				</tbody>
			</table>
			<Note kind="warn">
				A pulse does not know its role. A reader can still edit locally; the
				relay refuses the upload. Make your UI read-only for readers.
			</Note>

			<Note>
				On <a href="/docs/cloud">Pulsify Cloud</a>, authentication is built in:
				tokens carry an identity, each root stores its grants, and one socket
				serves every document of a root. See{" "}
				<a href="/docs/cloud/authentication">Cloud authentication</a>.
			</Note>

			<h2>Refreshing tokens</h2>
			<p>
				The token travels in the query string: keep it short-lived. Pass a
				socket factory so each new session reads the current token.
			</p>
			<CodeBlock title="refresh.ts" code={refresh} />

			<h2>Self-host</h2>
			<p>
				Authenticate the upgrade request however you like (cookie, header,
				token), then open the relay peer with the document and the role.
			</p>
			<CodeBlock title="server.ts" code={selfHost} />
			<Note kind="warn">
				Always pass <code>docId</code>. Without it, a socket authorized for one
				document can send frames for any other.
			</Note>
			<p>
				Serving from a database? <code>relayStoreMessage</code> takes the same
				session options.
			</p>
			<CodeBlock title="store.ts" code={store} />
			<p>
				Both relays also carry <a href="/docs/presence">presence</a>. Pass{" "}
				<code>subject</code> next to <code>docId</code> and every peer knows
				which user is behind a cursor. <code>PulseRelay</code> needs nothing
				else; a relay built on <code>relayStoreMessage</code> forwards the
				frames itself, as{" "}
				<a href="/docs/presence#your-own-relay">Your own relay</a> shows.
			</p>

			<h2>Errors and revocation</h2>
			<ul>
				<li>
					<strong>Refused upgrade:</strong> browsers hide the HTTP status, so
					the client only sees <code>CONNECTION_FAILED</code>. Fetch the token
					first to tell auth errors from network errors.
				</li>
				<li>
					<strong>Reader upload:</strong> the relay answers{" "}
					<code>FORBIDDEN</code> and keeps the socket open. Check{" "}
					<code>getPulseMeta(pulse).status</code>.
				</li>
				<li>
					<strong>Revocation:</strong> roles are evaluated when the socket
					opens. An expired token or removed grant applies on the next
					connection; close the socket server-side to cut access now.
				</li>
			</ul>
		</>
	);
}
