import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { ClientOnly, NoteDefinition } from "~/components/Frontend";

const install = `bun add @pulsify/react`;

const editor = `import { memo } from "react";
import { usePulse } from "@pulsify/react";
import type { NotePulse } from "./note";

export function Editor({ pulse }: { pulse: NotePulse }) {
  const note = usePulse(pulse);
  return (
    <>
      <input value={note.title} onChange={(e) => (note.title = e.target.value)} />
      <Author author={note.author} />
      <ul>{note.tags.map((tag, i) => <li key={i}>{tag}</li>)}</ul>
      <button onClick={() => note.tags.push("new")}>Add tag</button>
    </>
  );
}

// Skips while nothing it read changed: typing in the title leaves it alone.
const Author = memo(({ author }: { author: NotePulse["author"] }) => (
  <p>by {author.name}</p>
));`;

const page = `"use client";
import { useEffect, useState } from "react";
import { disconnectPulse, loadPulse } from "@pulsify/core";
import { Editor } from "./Editor";
import { Note, remote, type NotePulse } from "./note";

export function NotePage({ id }: { id: string }) {
  const [pulse, setPulse] = useState<NotePulse>();
  // Effects never run during server rendering.
  useEffect(() => {
    let loaded: NotePulse | undefined;
    let active = true;
    loadPulse(Note, id, { connectors: [remote] }).then((note) => {
      loaded = note;
      if (active) setPulse(note);
    });
    return () => {
      active = false;
      if (loaded) disconnectPulse(loaded);
    };
  }, [id]);
  return pulse ? <Editor key={id} pulse={pulse} /> : <p>Loading…</p>;
}`;

const suspense = `import { Suspense } from "react";

// On the server, usePulse throws and the boundary renders its fallback.
// The browser then renders the editor.
<Suspense fallback={<p>Loading…</p>}>
  <Editor pulse={pulse} />
</Suspense>`;

export default function React() {
	return (
		<>
			<Title>React · Docs</Title>
			<h1>React</h1>
			<p>
				<code>@pulsify/react</code> exports one hook, <code>usePulse</code>. A
				component re-renders only when a value it read changes, and objects
				keep their identity so <code>memo</code> children skip.
			</p>

			<h2>Install</h2>
			<CodeBlock title="terminal" code={install} />
			<p>
				It needs React 18 or 19 and <code>@pulsify/core</code>, nothing else.
			</p>

			<h2>The definition</h2>
			<NoteDefinition />

			<h2>Render and edit</h2>
			<CodeBlock title="Editor.tsx" code={editor} />
			<p>
				<code>usePulse</code> returns a proxy of the live pulse that records
				what the component, and the children it passes values to, read
				during render. Local and remote changes re-render it only when one of
				those values changed. Writes go straight to the pulse.
			</p>
			<ul>
				<li>
					Objects, arrays, rich text and trees keep their identity while
					nothing read below them changes, including after an array move.
				</li>
				<li>
					The pulse itself is renewed on every render. Pass{" "}
					<code>memo</code> children the part they show, or let them call{" "}
					<code>usePulse</code> on what they received.
				</li>
				<li>
					Rich text and trees are compared as a whole. Bind editors with the{" "}
					<a href="/docs/editors">ProseMirror and Lexical bindings</a>.
				</li>
				<li>Never write to the pulse during render.</li>
			</ul>

			<h2>Load on the client</h2>
			<ClientOnly how={'In React, load the pulse in an effect. In Next.js, that component needs "use client".'} />
			<CodeBlock title="NotePage.tsx" code={page} />
			<p>
				<code>usePulse</code> refuses to render on the server. When a
				component using it can be reached during server rendering, put it
				under a <code>&lt;Suspense&gt;</code> boundary:
			</p>
			<CodeBlock title="Page.tsx" code={suspense} />
			<Note>
				React reports the switch to client rendering through{" "}
				<code>onRecoverableError</code>. It is expected for client-only
				content.
			</Note>
		</>
	);
}
