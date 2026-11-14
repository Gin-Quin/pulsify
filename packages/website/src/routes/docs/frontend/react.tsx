import { Seo } from "~/components/Seo";
import { CodeBlock } from "~/components/CodeBlock";
import { GITHUB_URL } from "~/components/links";
import { DefaultConnectors, NeverOnTheServer } from "~/components/Frontend";

const install = `bun add pulsify-core pulsify-react`;

const load = `"use client";
import { Suspense } from "react";
import { useLoadPulse } from "pulsify-react";
// Project has documents: array(sub(Document)).
import { Document, Project } from "./project";

export function ProjectPage({ id }: { id: string }) {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <ProjectView id={id} />
    </Suspense>
  );
}

function ProjectView({ id }: { id: string }) {
  // Suspends until the pulse is loaded, and again when the ID changes.
  const project = useLoadPulse(Project, id);
  return (
    <>
      <input value={project.name} onChange={(e) => (project.name = e.target.value)} />
      <ul>
        {project.documents.map((document) => (
          <Suspense key={document.id} fallback={<li>…</li>}>
            <DocumentRow id={document.id} />
          </Suspense>
        ))}
      </ul>
      <button onClick={() => project.documents.pop()}>Remove the last one</button>
    </>
  );
}

// Loaded with the project, so at once; a document added later loads here.
function DocumentRow({ id }: { id: string }) {
  const document = useLoadPulse(Document, id);
  return <li>{document.title}</li>;
}`;

const create = `"use client";
import { useState } from "react";
import { createPulse } from "pulsify-core";
import { usePulse } from "pulsify-react";
import { Project, type ProjectPulse } from "./project";

export function NewProject() {
  const [pulse, setPulse] = useState<ProjectPulse>();
  const create = () => setPulse(createPulse(Project, { name: "Untitled", documents: [] }));
  return (
    <>
      <button onClick={create}>New project</button>
      {pulse && <ProjectName pulse={pulse} />}
    </>
  );
}

function ProjectName({ pulse }: { pulse: ProjectPulse }) {
  const project = usePulse(pulse);
  return <input value={project.name} onChange={(e) => (project.name = e.target.value)} />;
}`;

const presence = `"use client";
import { usePulsePresence } from "pulsify-react";
import { Cursor } from "./presence";
import type { ProjectPulse } from "./project";

export function Cursors({ project }: { project: ProjectPulse }) {
  // Joins on mount, leaves on unmount.
  const cursors = usePulsePresence(project, Cursor);
  return (
    <div
      className="board"
      onPointerMove={(e) => cursors.set({ x: e.clientX, y: e.clientY })}
      onPointerLeave={() => cursors.set(undefined)}
    >
      {cursors.others.map(({ peer, state }) => (
        <i key={peer} className="cursor" style={{ left: state.x, top: state.y }} />
      ))}
    </div>
  );
}`;

const never = `import { loadPulse } from "pulsify-core";
import { Project } from "./project";

// DANGEROUS: a Server Component runs on the server.
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await loadPulse(Project, id);
  return <h1>{project.name}</h1>;
}`;

export default function React() {
	return (
		<>
			<Seo
				title="React · Pulsify Docs"
				description="pulsify-react hooks load a pulse with Suspense, show it and share presence. A component re-renders only when a value it read changes."
			/>
			<h1>React</h1>
			<p>
				<code>pulsify-react</code> exports three hooks.{" "}
				<code>useLoadPulse</code> loads a pulse and suspends until it is loaded;{" "}
				<code>usePulse</code> shows a pulse you already hold;{" "}
				<code>usePulsePresence</code> shares live state such as cursors. A
				component re-renders only when a value it read changes, after a local or
				remote change. It needs React 18 or 19.
			</p>
			<CodeBlock title="terminal" code={install} />

			<DefaultConnectors file="main.ts" />

			<h2>Load a pulse</h2>
			<p>
				Call <code>useLoadPulse</code> under a <code>&lt;Suspense&gt;</code>{" "}
				boundary, which shows its fallback while the pulse loads. A pulse loaded
				or created already is returned at once. The value it returns reads and
				writes like any object: assignments and array methods go straight to the
				pulse, which syncs them to every peer.
			</p>
			<CodeBlock title="ProjectPage.tsx" code={load} />
			<p>
				Objects and arrays keep their identity while nothing read below them
				changes, so <code>memo</code> children skip. Never write to a pulse
				during render. The{" "}
				<a href={`${GITHUB_URL}/blob/main/packages/pulsify-react/README.md`}>
					package README
				</a>{" "}
				has the details.
			</p>

			<h2>Create a pulse</h2>
			<p>
				<code>createPulse</code> is synchronous, so an event handler can create
				a pulse and show it at once. Give it to a component that calls{" "}
				<code>usePulse</code>.
			</p>
			<CodeBlock title="NewProject.tsx" code={create} />

			<h2>Presence</h2>
			<p>
				<code>usePulsePresence</code> joins a{" "}
				<a href="/docs/presence">presence channel</a> of a pulse while the
				component is mounted. It returns <code>others</code>, <code>mine</code>{" "}
				and <code>set</code>, and re-renders when the others or your own state
				change. A peer whose state did not change keeps the same object, so{" "}
				<code>memo</code> children skip.
			</p>
			<CodeBlock title="Cursors.tsx" code={presence} />
			<p>
				<code>set</code> keeps its identity between renders, for one pulse and
				channel, and can be called from handlers and effects, never during
				render. Like <code>usePulse</code>, the hook refuses to render on the
				server.
			</p>
			<p>
				It needs a connector that relays presence: Pulsify Cloud, or your own
				relay with <code>presence: true</code>.{" "}
				<a href="/docs/presence#where-it-works">Where it works →</a>
			</p>

			<NeverOnTheServer
				file="app/projects/[id]/page.tsx (Next.js)"
				code={never}
			>
				The same goes for route handlers, server actions and{" "}
				<code>getServerSideProps</code>. A <code>"use client"</code> component
				is still rendered on the server, so never load a pulse while it renders
				either: no <code>use(loadPulse(…))</code>, no <code>useMemo</code>. Use{" "}
				<code>useLoadPulse</code>, which refuses to load on the server, as{" "}
				<code>usePulse</code> refuses to render there: the nearest{" "}
				<code>&lt;Suspense&gt;</code> boundary shows its fallback, then the
				browser renders the content.
			</NeverOnTheServer>
		</>
	);
}
