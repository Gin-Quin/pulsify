import { Seo } from "~/components/Seo";
import { CodeBlock } from "~/components/CodeBlock";

const deletion = `import { createCloudClient } from "pulsify-cloud";

const cloud = createCloudClient({ url, credential: process.env.PULSIFY_API_KEY! });
await cloud.deleteDocument("alice/notes/n1"); // the note, its sub-documents, their grants
await cloud.deleteDocument("alice");          // the whole root: its Durable Object is deleted`;

const cloudSnapshots = `import { destroyPulse, restorePulse } from "pulsify-core";
import { createCloudClient } from "pulsify-cloud";

// In the browser, with the user's token: an editor snapshots, a reader opens.
const cloud = createCloudClient({ url, credential: () => fetchToken() });

const saved = await cloud.snapshot(note.id, { label: "Sent to the client" });
await cloud.snapshots(note.id); // [{ id, time, label, subject, version }], oldest first

const old = await cloud.loadSnapshot(Note, note.id, saved.id); // a read-only pulse
restorePulse(note, old); // the client writes the restore, sent like any edit
destroyPulse(old);

await cloud.deleteSnapshot(note.id, saved.id); // an owner`;

const expiry = `import { createCloudClient } from "pulsify-cloud";

const cloud = createCloudClient({ url, credential: process.env.PULSIFY_API_KEY! });

// A meeting room, a game, a whiteboard: it lives while someone uses it.
const room = \`room-\${crypto.randomUUID()}\`;
await cloud.grant({ subject: "*", prefix: room, role: "editor" });
await cloud.expire(room, { idleMs: 10 * 60_000 }); // erased ten minutes after the last socket closed`;

export default function CloudDocuments() {
	return (
		<>
			<Seo
				title="Managing cloud documents · Pulsify Docs"
				description="Delete documents and roots on Pulsify Cloud, take and restore snapshots, and let a root erase itself once nobody uses it."
			/>
			<h1>Managing documents</h1>
			<p>
				The management client erases documents, keeps snapshots of them and
				gives a root a lifetime. It takes the API key on your backend, or the
				token of a user with the <a href="/docs/cloud/authentication">role</a>{" "}
				each call asks for.
			</p>

			<h2>Delete documents</h2>
			<p>
				<code>deleteDocument</code> erases a document, everything below it and
				the grants on them. It takes the API key, or the token of an owner of
				the document. Open pulses of an erased document stop with{" "}
				<code>NOT_FOUND</code> instead of uploading it again. Deleting the root
				document deletes the root and its Durable Object.
			</p>
			<CodeBlock title="delete.ts" code={deletion} />
			<p>
				The server keeps no trace of a deleted document: a client that still has
				it offline and may write it uploads it again when it reconnects. Delete
				it on your clients too, or revoke the grants that cover it.
			</p>

			<h2 id="snapshots">Snapshots</h2>
			<p>
				A field keeps its last value only, unless it is{" "}
				<a href="/docs/modifiers#versioned">versioned</a>. To go back to a past
				state of a document without keeping every edit, take snapshots of it:
				the server copies the rows it holds for the document, with its clock and
				the subject of the token, without ever reading them. A snapshot has the
				size of the document, counts in your storage, and is erased with it. For
				a document that keeps every write, it is the version alone and stores
				nothing more.
			</p>
			<CodeBlock title="snapshots.ts" code={cloudSnapshots} />
			<p>
				An editor of the document creates snapshots, a reader lists and opens
				them, an owner erases them, and the API key does all of it. The server
				copies what it has received, so take a snapshot once the pulse is{" "}
				<code>synced</code>. Opening one gives a read-only pulse, detached from
				the live document, to render with the same components; the{" "}
				<a href="/docs/migrations">migrations</a> added since it was made are
				applied to it. <code>restorePulse</code> then replaces the live document
				by a new <a href="/docs/modifiers#restore">generation</a> of it.
			</p>

			<h2>Expire roots</h2>
			<p>
				Some roots only matter while people use them: a call, a game, a
				whiteboard shared for a meeting. <code>expire</code> gives a root a
				lifetime without sockets. Once its last socket has been closed for{" "}
				<code>idleMs</code>, the root erases itself with its documents, its
				grants and its Durable Object, and no longer counts in your storage. Any
				socket that opens in the meantime starts the countdown again, so a
				reload or a lost network does not end a room. A root that nobody
				connects to expires too, counted from the call.
			</p>
			<CodeBlock title="rooms.ts" code={expiry} />
			<p>
				It takes the API key, or the token of an owner of the root, and{" "}
				<code>idleMs</code> from a minute to thirty days. Calling it again
				replaces the lifetime. An expiring root is erased instead of compacted.
				Unlike <code>deleteDocument</code>, an expired root leaves no tombstone:
				its ID can be used again, as a new and empty root, after you grant
				access to it again. Until then, clients that still have the link get{" "}
				<code>FORBIDDEN</code>, and the empty root they wake up erases itself
				once they leave. The <a href="/demos">demos</a> work this way.
			</p>
		</>
	);
}
