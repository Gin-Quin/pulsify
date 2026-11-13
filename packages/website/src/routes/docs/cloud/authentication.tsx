import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { SequenceDiagram } from "~/components/SequenceDiagram";

const secrets = `PULSIFY_URL           https://api.pulsify.cloud/<your-project>
PULSIFY_TOKEN_SECRET  shared by your backend and the cloud; signs user tokens (≥ 32 chars)
PULSIFY_API_KEY       your backend only; manages grants and reads usage (≥ 32 chars)`;

const sign = `import { signCloudToken } from "pulsify-cloud";

// GET /api/pulsify-token, behind your own login (session cookie, OAuth, …)
export async function pulsifyToken(user: User) {
  const token = await signCloudToken(
    { subject: user.id },                 // who, not what: rights live in the roots
    process.env.PULSIFY_TOKEN_SECRET!,
    { expiresIn: "15m" },
  );
  return new Response(token);
}`;

const resolve = `grants of root "alice":
  alice  alice           owner
  bob    alice/notes/n1  editor
  *      alice/public    reader

                     alice   bob     carol
alice                owner   —       —
alice/notes/n1       owner   editor  —
alice/notes/n1/img   owner   editor  —      inherited
alice/notes/n2       owner   —       —
alice/public/cv      owner   reader  reader "*" is every authenticated user
alice2               —       —       —      another root: prefixes stop at "/"`;

const admin = `import { createCloudClient } from "pulsify-cloud";

const cloud = createCloudClient({
  url: process.env.PULSIFY_URL!,
  credential: process.env.PULSIFY_API_KEY!,   // never ship this key to a browser
});

// A new user owns the root named after them
await cloud.grant({ subject: user.id, prefix: user.id, role: "owner" });

// A team root, shared by its members
await cloud.grant({ subject: "u1", prefix: "acme", role: "owner" });
await cloud.grant({ subject: "u2", prefix: "acme", role: "editor" });
await cloud.grant({ subject: "*", prefix: "acme/handbook", role: "reader" });

await cloud.grants("acme");                          // every grant of the root
await cloud.grants("acme", { subject: "u2" });       // filtered
await cloud.revoke({ subject: "u2", prefix: "acme" });
await cloud.usage("acme"); // { root, documents, rows, bytes, connections }`;

const share = `import { createCloudClient } from "pulsify-cloud";

// In the browser, with the user's own token: owners manage their subtree.
const access = createCloudClient({
  url: PULSIFY_URL,
  credential: () => fetch("/api/pulsify-token").then((response) => response.text()),
});
await access.grant({ subject: "bob", prefix: note.id, role: "editor" });
await access.grants("alice"); // grants under the prefixes Alice owns, and her own`;

const http = `curl -X PUT "$PULSIFY_URL/v1/roots/alice/grants" \\
  -H "Authorization: Bearer $PULSIFY_API_KEY" \\
  -d '{"subject":"bob","prefix":"alice/notes/n1","role":"editor"}'
# {"grant":{"subject":"bob","prefix":"alice/notes/n1","role":"editor"}}

curl -X DELETE "$PULSIFY_URL/v1/roots/alice/grants?subject=bob&prefix=alice%2Fnotes%2Fn1" \\
  -H "Authorization: Bearer $PULSIFY_API_KEY"
# {"removed":true}

# Errors: {"error":{"code":"FORBIDDEN","message":"…"}} with the matching HTTP status`;

const roles = `const cloud = createCloudConnector({ url, token });

cloud.roleOf("alice/notes/n1");   // "reader" | "editor" | "owner" | null | undefined
const stop = cloud.onRole((docId, role) => {
  // Sent when a document is opened, then on every grant change.
  // null: no access, or access revoked while the document was open.
});`;

export default function CloudAuthentication() {
	return (
		<>
			<Title>Cloud authentication · Docs</Title>
			<h1>Authentication</h1>
			<p>
				Authentication is built in and split in two. A <strong>token</strong>{" "}
				says who the user is; your backend signs it after your own login. A{" "}
				<strong>grant table</strong> in each root says what that user may do.
				The cloud checks the token once per socket and the grants on every
				frame.
			</p>
			<SequenceDiagram
				caption="Identity comes from your backend; rights come from the root."
				actors={["Client", "Your backend", "Gateway", "Root"]}
				steps={[
					{ from: 0, to: 1, label: "GET /api/pulsify-token" },
					{ from: 1, to: 1, label: "signCloudToken({ subject })" },
					{ from: 1, to: 0, label: "token", reply: true },
					{ from: 0, to: 2, label: "upgrade + token subprotocol" },
					{ from: 2, to: 2, label: "verify signature, expiry" },
					{ from: 2, to: 3, label: "socket for subject" },
					{ from: 0, to: 3, label: "connect alice/notes/n1" },
					{ from: 3, to: 3, label: "grants → role" },
					{ from: 3, to: 0, label: "role + sync, or FORBIDDEN", reply: true },
				]}
			/>

			<h2>Secrets</h2>
			<p>
				Your project URL and its two secrets are on the{" "}
				<a href="/dashboard">dashboard</a>. Each project has its own. Rotate a
				secret there if it leaks: the old value stops working within a minute.
			</p>
			<CodeBlock title="environment" code={secrets} />

			<h2>Sign tokens</h2>
			<p>
				Tokens are short-lived HS256 JWTs with the <code>pulsify-cloud</code>{" "}
				audience. They carry no rights, so they never go stale when you share a
				document.
			</p>
			<CodeBlock title="backend.ts" code={sign} />
			<p>
				The connector calls its <code>token</code> function for each new socket.
				An expired token only matters at the next reconnection: open sockets are
				not cut when it expires.
			</p>

			<h2>Roles</h2>
			<table>
				<thead>
					<tr>
						<th>Role</th>
						<th>Load and receive updates</th>
						<th>Upload changes, create documents</th>
						<th>Manage grants of the prefix</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>none</td>
						<td>
							<code>FORBIDDEN</code>
						</td>
						<td>—</td>
						<td>—</td>
					</tr>
					<tr>
						<td>
							<code>reader</code>
						</td>
						<td>yes</td>
						<td>
							<code>FORBIDDEN</code>
						</td>
						<td>no</td>
					</tr>
					<tr>
						<td>
							<code>editor</code>
						</td>
						<td>yes</td>
						<td>yes</td>
						<td>no</td>
					</tr>
					<tr>
						<td>
							<code>owner</code>
						</td>
						<td>yes</td>
						<td>yes</td>
						<td>yes</td>
					</tr>
				</tbody>
			</table>
			<p>
				A grant covers its prefix and everything below it. Grants only add
				access, and the strongest one wins. The subject <code>*</code> matches
				every authenticated user.
			</p>
			<CodeBlock title="how grants resolve" code={resolve} />

			<h2>Grant rights from your backend</h2>
			<p>
				Nothing is granted automatically, not even to a user on the root named
				after them. Grant it when your app creates the user, the team or the
				project.
			</p>
			<CodeBlock title="backend.ts" code={admin} />

			<h2>Let owners share</h2>
			<p>
				An owner can grant and revoke roles inside the prefixes they own, with
				their own token. That is enough for a share dialog without a backend
				route.
			</p>
			<CodeBlock title="share.ts" code={share} />
			<p>Every client is a thin layer over the same HTTP API:</p>
			<CodeBlock title="terminal" code={http} />

			<h2>Live changes</h2>
			<p>
				Grants are stored in the root that serves the sockets, so a change
				applies to open sessions at once:
			</p>
			<ul>
				<li>
					<strong>Upgrade</strong> (reader → editor): the client receives the
					new role and its next uploads are accepted.
				</li>
				<li>
					<strong>Downgrade</strong> (editor → reader): later uploads are
					refused with <code>FORBIDDEN</code>.
				</li>
				<li>
					<strong>Revocation</strong>: the document is unsubscribed and the
					pulse fails with <code>FORBIDDEN</code>. Other documents on the same
					socket are untouched.
				</li>
			</ul>
			<p>Show the role in your UI, for example to make an editor read-only:</p>
			<CodeBlock title="roles.ts" code={roles} />

			<h2>Errors</h2>
			<table>
				<thead>
					<tr>
						<th>Situation</th>
						<th>What the client sees</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>Missing, forged or expired token</td>
						<td>
							Upgrade refused with 401. Browsers hide the status: the load fails
							with <code>CONNECTION_FAILED</code>.
						</td>
					</tr>
					<tr>
						<td>Valid token, no grant on the document</td>
						<td>
							<code>loadPulse</code> rejects with <code>FORBIDDEN</code>;{" "}
							<code>roleOf</code> returns <code>null</code>.
						</td>
					</tr>
					<tr>
						<td>Reader edits locally</td>
						<td>
							The upload is refused with <code>FORBIDDEN</code>, reported to{" "}
							<code>onError</code>; other clients never see the edit.
						</td>
					</tr>
					<tr>
						<td>Management call without owner rights</td>
						<td>
							HTTP 403 <code>FORBIDDEN</code>; 401 without valid credentials.
						</td>
					</tr>
				</tbody>
			</table>
			<Note kind="warn">
				A pulse does not know its role: a reader can still change its local
				copy. Use <code>roleOf</code> to make your UI read-only.
			</Note>
		</>
	);
}
