import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";

const install = `bun add pulsify-core pulsify-cloud pulsify-prosemirror \\
  prosemirror-model prosemirror-state prosemirror-transform prosemirror-view \\
  prosemirror-schema-basic prosemirror-history`;

const layout = `alice                  Notebook: the root, owned by Alice
├── alice/3f2c…        Note: title + rich-text body
└── alice/9a71…        Note
bob                    Bob's own notebook, another root`;

const schema = `import {
  array, definePulse, object, richText, sub,
  type ModelFromDefinition, type Pulse,
} from "pulsify-core";

export const Note = definePulse("Note", object({
  title: "string",
  body: richText(),
})).materialize();

// One notebook per user: the root document. Each note is a sub-document.
export const Notebook = definePulse("Notebook", object({
  name: "string",
  notes: array(sub(Note)),
})).materialize();

export type NotePulse = Pulse<ModelFromDefinition<typeof Note>>;
export type NotebookPulse = Pulse<ModelFromDefinition<typeof Notebook>>;`;

const backend = `import { createCloudClient, signCloudToken } from "pulsify-cloud";

const cloud = createCloudClient({
  url: process.env.PULSIFY_URL!,            // your Worker or Unikraft instance
  credential: process.env.PULSIFY_API_KEY!,  // server side only
});

// Call this where your app creates a user.
export async function onSignUp(user: { id: string }) {
  await cloud.grant({ subject: user.id, prefix: user.id, role: "owner" });
}

// GET /api/pulsify-token, behind your session middleware.
export async function pulsifyToken(user: { id: string }) {
  const token = await signCloudToken(
    { subject: user.id },
    process.env.PULSIFY_TOKEN_SECRET!,
    { expiresIn: "15m" },
  );
  return new Response(token);
}`;

const connector = `import { createCloudConnector } from "pulsify-cloud";

export const PULSIFY_URL = "https://pulsify.example.com";
export const fetchToken = () =>
  fetch("/api/pulsify-token").then((response) => response.text());

// One connector for the whole app. It opens one socket per root, on demand.
export const cloud = createCloudConnector({ url: PULSIFY_URL, token: fetchToken });`;

const notebook = `import { connectPulse, createPulse, loadPulse, PulseError, subPulse } from "pulsify-core";
import { cloud } from "./cloud";
import { Note, Notebook, type NotebookPulse, type NotePulse } from "./schema";

export async function openNotebook(userId: string): Promise<NotebookPulse> {
  try {
    // include: true subscribes to the root and every note, over one socket.
    return await loadPulse(Notebook, userId, { connectors: [cloud], include: true });
  } catch (error) {
    if (!(error instanceof PulseError) || error.code !== "NOT_FOUND") throw error;
    // First visit: create the root. Alice's owner grant allows it.
    const notebook = createPulse(
      Notebook,
      { id: userId, name: "My notes", notes: [] },
      { connectors: [cloud] },
    );
    await connectPulse(notebook).synced;
    return notebook;
  }
}

export async function addNote(notebook: NotebookPulse, title: string): Promise<NotePulse> {
  // { parent } gives the note the ID "<userId>/<uuid>": same root, same socket.
  const note = createPulse(Note, { title, body: "" }, { parent: notebook });
  await connectPulse(note).synced;      // store the note first,
  notebook.notes.push(subPulse(note));  // then link it: no one loads a dangling ID
  return note;
}`;

const editor = `import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { history } from "prosemirror-history";
import { bindProseMirror } from "pulsify-prosemirror";
import { cloud } from "./cloud";
import type { NotePulse } from "./schema";

export function openEditor(note: NotePulse, element: HTMLElement) {
  const view = new EditorView(element, {
    state: EditorState.create({ schema, plugins: [history()] }),
    editable: () => cloud.roleOf(note.id) !== "reader",
  });
  const binding = bindProseMirror(view, note.body, {
    onError: (error) => console.error(error),
  });
  // A grant can change while the note is open: re-evaluate \`editable\`.
  const stop = cloud.onRole((docId) => {
    if (docId === note.id) view.setProps({});
  });
  return () => {
    stop();
    binding.destroy();
    view.destroy();
  };
}`;

const app = `import { subscribePulse } from "pulsify-core";
import { addNote, openNotebook } from "./notebook";
import { openEditor } from "./editor";

const notebook = await openNotebook(currentUser.id);
const list = document.querySelector("#notes")!;
const editor = document.querySelector<HTMLElement>("#editor")!;
let closeEditor: (() => void) | undefined;

function render() {
  list.replaceChildren(
    ...notebook.notes.map((handle) => {
      const item = document.createElement("li");
      item.textContent = handle.pulse?.title ?? "…";
      item.onclick = () => open(handle.id);
      return item;
    }),
  );
}

async function open(noteId: string) {
  const handle = notebook.notes.find((note) => note.id === noteId)!;
  // Loaded by include: true; a note added on another device loads here.
  const note = handle.pulse ?? (await handle.load());
  closeEditor?.();
  closeEditor = openEditor(note, editor);
}

subscribePulse(notebook, render);   // notes added on another device show up
render();

document.querySelector("#add")!.addEventListener("click", async () => {
  const note = await addNote(notebook, prompt("Title") ?? "Untitled");
  await open(note.id);
});
`;

const share = `import { createCloudClient } from "pulsify-cloud";
import { fetchToken, PULSIFY_URL } from "./cloud";

// Alice owns her root, so her own token can grant roles inside it.
const access = createCloudClient({ url: PULSIFY_URL, credential: fetchToken });

export const shareNote = (noteId: string, userId: string, role: "reader" | "editor") =>
  access.grant({ subject: userId, prefix: noteId, role });

export const unshareNote = (noteId: string, userId: string) =>
  access.revoke({ subject: userId, prefix: noteId });`;

const shared = `import { loadPulse } from "pulsify-core";
import { cloud } from "./cloud";
import { openEditor } from "./editor";
import { Note } from "./schema";

// Bob opens "alice/3f2c…" from a link. His connector opens a second socket,
// to Alice's root, subscribed to this note only.
const note = await loadPulse(Note, sharedNoteId, { connectors: [cloud] });
const close = openEditor(note, document.querySelector("#editor")!);

cloud.roleOf(note.id); // "editor", or "reader": the editor is then read-only`;

const check = `cloud.connections.map(({ root, server, documents }) => ({ root, server, documents }));
// [{ root: "alice", server: { backend: "cloudflare", id: "8c1e…", location: "CDG" },
//    documents: ["alice", "alice/3f2c…", "alice/9a71…"] }]

await adminClient.usage("alice");
// { root: "alice", documents: 3, rows: 42, bytes: 5120, connections: 2 }`;

export default function CloudTutorial() {
	return (
		<>
			<Title>Tutorial: a notes app · Docs</Title>
			<h1>Tutorial: a notes app</h1>
			<p>
				We build a small notes app on Pulsify Cloud. Each user owns a{" "}
				<strong>notebook</strong>, the root document named after their user ID.
				Each <strong>note</strong> is a sub-document with a rich-text body
				edited in ProseMirror. Notes sync live across devices, work offline, and
				can be shared with other users.
			</p>
			<CodeBlock title="documents" code={layout} />
			<p>
				The code is the same for both backends. Deploy one first:{" "}
				<a href="/docs/cloud/cloudflare">Cloudflare</a> or{" "}
				<a href="/docs/cloud/unikraft-cloud">Unikraft Cloud</a>. You need its
				URL, <code>PULSIFY_TOKEN_SECRET</code> and <code>PULSIFY_API_KEY</code>.
			</p>

			<h2>1. Install</h2>
			<CodeBlock title="terminal" code={install} />

			<h2>2. Define the documents</h2>
			<p>
				Shared by your backend and your client. <code>sub(Note)</code> stores
				the ID of a child pulse whose ID starts with the notebook's.
			</p>
			<CodeBlock title="schema.ts" code={schema} />

			<h2>3. Grant and sign on your backend</h2>
			<p>
				Two small additions to the server you already have: give each new user
				the <code>owner</code> role on their root, and hand signed-in users a
				short-lived token.
			</p>
			<CodeBlock title="backend.ts" code={backend} />
			<Note>
				Users that already exist need the grant too: run <code>onSignUp</code>{" "}
				once for each of them.
			</Note>

			<h2>4. Create the connector</h2>
			<CodeBlock title="cloud.ts" code={connector} />

			<h2>5. Open the notebook and add notes</h2>
			<p>
				The first visit creates the root; later visits load it with all its
				notes. Adding a note creates a sub-document and links it.
			</p>
			<CodeBlock title="notebook.ts" code={notebook} />

			<h2>6. Edit notes with ProseMirror</h2>
			<p>
				Bind an editor to the note's <code>body</code>. Every transaction
				becomes native character operations, synced through the note's
				subscription.
			</p>
			<CodeBlock title="editor.ts" code={editor} />

			<h2>7. Wire the page</h2>
			<CodeBlock title="app.ts" code={app} />
			<p>
				Open the app on two devices: typing in one appears in the other. Go
				offline and keep typing: the connector retries on its own, and once the
				cloud is reachable again the missing rows are exchanged both ways, over
				one socket for the whole notebook. Tell the user with{" "}
				<code>subscribePulseStatus(notebook, (status) =&gt; …)</code>, which
				reports <code>"offline"</code>, <code>"synced"</code>… as they happen.
			</p>

			<h2>8. Share a note</h2>
			<p>
				Alice owns her root, so she can grant Bob a role on one note from the
				browser, with her own token. Bob gets nothing else in Alice's root.
			</p>
			<CodeBlock title="share.ts" code={share} />
			<CodeBlock title="shared-note.ts" code={shared} />
			<p>
				Changing Bob's role updates his open editor immediately; revoking it
				closes his subscription to the note with <code>FORBIDDEN</code>.
			</p>

			<h2>9. Check what is open</h2>
			<CodeBlock title="console" code={check} />

			<h2>Where to go next</h2>
			<ul>
				<li>
					<a href="/docs/local-persistence">Local persistence</a>: keep notes
					across reloads and start the app without network, with{" "}
					<code>pulsify-indexeddb</code>.
				</li>
				<li>
					<a href="/docs/cloud/authentication">Authentication</a>: roles, public
					documents with <code>*</code>, team roots.
				</li>
				<li>
					<a href="/docs/editors">Rich text editors</a>: Lexical, custom
					schemas, rules of the road.
				</li>
				<li>
					<a href="/docs/migrations">Migrations</a>: change the{" "}
					<code>Note</code> schema without breaking stored notes.
				</li>
			</ul>
		</>
	);
}
