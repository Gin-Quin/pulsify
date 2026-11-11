import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { ClientOnly, NoteDefinition } from "~/components/Frontend";

const helper = `import { onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { snapshotPulse, subscribePulse, type Pulse } from "@pulsify/core";

/** A read-only store that follows the pulse. Write to the pulse itself. */
export function createPulseStore<P extends Pulse<any>>(pulse: P) {
  const [store, setStore] = createStore(snapshotPulse(pulse));
  onCleanup(subscribePulse(pulse, (p) => setStore(reconcile(snapshotPulse(p)))));
  return store;
}`;

const editor = `import { For } from "solid-js";
import { createPulseStore } from "./createPulseStore";
import type { NotePulse } from "./note";

export function Editor(props: { pulse: NotePulse }) {
  const note = createPulseStore(props.pulse);
  return (
    <>
      <input value={note.title} onInput={(e) => (props.pulse.title = e.currentTarget.value)} />
      <p>by {note.author.name}</p>
      <ul>
        <For each={note.tags}>{(tag) => <li>{tag}</li>}</For>
      </ul>
      <button onClick={() => props.pulse.tags.push("new")}>Add tag</button>
    </>
  );
}`;

const page = `// src/components/NotePage.tsx: imported with clientOnly, so it never runs on the server.
import { useParams } from "@solidjs/router";
import { createResource, onCleanup, Show } from "solid-js";
import { disconnectPulse, loadPulse } from "@pulsify/core";
import { Editor } from "./Editor";
import { Note, remote } from "./note";

export default function NotePage() {
  const params = useParams();
  const [pulse] = createResource(() => params.id, (id) => loadPulse(Note, id, { connectors: [remote] }));
  onCleanup(() => pulse() && disconnectPulse(pulse()!));
  return (
    <Show when={pulse()} keyed fallback={<p>Loading…</p>}>
      {(note) => <Editor pulse={note} />}
    </Show>
  );
}`;

const route = `// src/routes/notes/[id].tsx
import { clientOnly } from "@solidjs/start";

const NotePage = clientOnly(() => import("~/components/NotePage"));

export default function Route() {
  return <NotePage fallback={<p>Loading…</p>} />;
}`;

export default function Solid() {
	return (
		<>
			<Title>Solid · Docs</Title>
			<h1>Solid</h1>
			<p>
				No extra package: a Solid store mirrors the pulse, and{" "}
				<code>reconcile</code> updates only the fields that changed. Every
				effect and DOM node depends on exactly what it reads.
			</p>

			<h2>The definition</h2>
			<NoteDefinition />

			<h2>The helper</h2>
			<CodeBlock title="createPulseStore.ts" code={helper} />
			<p>
				Each local or remote change takes a snapshot and reconciles it into
				the store. Rich text reads as its plain text, a sub-pulse as its ID.
				The cost is one snapshot per change; split very large documents into
				sub-pulses.
			</p>

			<h2>Render and edit</h2>
			<CodeBlock title="Editor.tsx" code={editor} />
			<p>
				Read from the store, write to the pulse. A write commits, notifies the
				store synchronously and syncs to every peer.
			</p>
			<Note>
				<code>createPulseStore</code> reads <code>props.pulse</code> once. Use
				a keyed <code>&lt;Show&gt;</code>, as below, so a new pulse mounts a
				new editor.
			</Note>

			<h2>Load on the client</h2>
			<ClientOnly how="In SolidStart, render the component that loads the pulse with clientOnly." />
			<CodeBlock title="src/components/NotePage.tsx" code={page} />
			<CodeBlock title="src/routes/notes/[id].tsx" code={route} />
		</>
	);
}
