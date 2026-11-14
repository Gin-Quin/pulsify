import { Seo } from "~/components/Seo";
import { CodeBlock } from "~/components/CodeBlock";
import { DefaultConnectors, NeverOnTheServer } from "~/components/Frontend";

const install = `bun add pulsify-core pulsify-solid`;

const load = `import { For, Show } from "solid-js";
import { createPulseResource } from "pulsify-solid";
// Project has documents: array(sub(Document)).
import { Document, Project } from "./project";

export default function ProjectPage(props: { id: string }) {
  // Loaded again when the ID changes.
  const [project] = createPulseResource(Project, () => props.id);
  return (
    <Show when={project()} fallback={<p>Loading…</p>}>
      {(project) => (
        <>
          <input
            value={project().name}
            onInput={(e) => (project().name = e.currentTarget.value)}
          />
          <ul>
            <For each={project().documents}>
              {(document) => <DocumentRow id={document.id} />}
            </For>
          </ul>
          <button onClick={() => project().documents.pop()}>Remove the last one</button>
        </>
      )}
    </Show>
  );
}

// Loaded with the project, so at once; a document added later loads here.
function DocumentRow(props: { id: string }) {
  const [document] = createPulseResource(Document, () => props.id);
  return <li>{document()?.title}</li>;
}`;

const create = `import { Show } from "solid-js";
import { createPulse } from "pulsify-core";
import { createPulseSignal } from "pulsify-solid";
import { Project, type ProjectPulse } from "./project";

export function NewProject() {
  const [project, setProject] = createPulseSignal<ProjectPulse>();
  const create = () => setProject(createPulse(Project, { name: "Untitled", documents: [] }));
  return (
    <>
      <button onClick={create}>New project</button>
      <Show when={project()}>
        {(project) => (
          <input
            value={project().name}
            onInput={(e) => (project().name = e.currentTarget.value)}
          />
        )}
      </Show>
    </>
  );
}`;

const wrap = `import { loadPulse } from "pulsify-core";
import { createMutablePulse } from "pulsify-solid";
import { Project } from "./project";

// A plain pulse: what reads it never re-renders.
const pulse = await loadPulse(Project, id);

// The reactive view of that pulse. A write to either one reaches the same
// document and re-renders what reads the view.
const project = createMutablePulse(pulse);

createMutablePulse(pulse) === project; // true: one view per pulse
createMutablePulse(project) === project; // true: a view is returned as is`;

const presence = `import { For } from "solid-js";
import { createPulsePresence } from "pulsify-solid";
import { Cursor } from "./presence";
import type { ProjectPulse } from "./project";

export function Cursors(props: { project: ProjectPulse }) {
  // Joins now, leaves when its owner is disposed.
  const cursors = createPulsePresence(props.project, Cursor);
  return (
    <div
      class="board"
      onPointerMove={(e) => cursors.set({ x: e.clientX, y: e.clientY })}
      onPointerLeave={() => cursors.set(undefined)}
    >
      <For each={cursors.others}>
        {({ state }) => <i class="cursor" style={{ left: state.x + "px", top: state.y + "px" }} />}
      </For>
    </div>
  );
}`;

const never = `import { query } from "@solidjs/router";
import { loadPulse, snapshotPulse } from "pulsify-core";
import { Project } from "~/project";

// DANGEROUS: "use server" runs on the server.
const getProject = query(async (id: string) => {
  "use server";
  return snapshotPulse(await loadPulse(Project, id));
}, "project");`;

const route = `import { useParams } from "@solidjs/router";
import { clientOnly } from "@solidjs/start";

const ProjectPage = clientOnly(() => import("~/components/ProjectPage"));

export default function Route() {
  const params = useParams();
  return <ProjectPage id={params.id} fallback={<p>Loading…</p>} />;
}`;

export default function Solid() {
	return (
		<>
			<Seo
				title="Solid · Pulsify Docs"
				description="pulsify-solid makes pulses reactive in Solid, as createMutable does for a plain object: what reads them re-renders after any change."
			/>
			<h1>Solid</h1>
			<p>
				<code>pulsify-solid</code> makes pulses reactive, as{" "}
				<code>createMutable</code> does for a plain object: what reads them
				re-renders after a local or remote change.
			</p>
			<CodeBlock title="terminal" code={install} />

			<DefaultConnectors file="src/entry-client.tsx" />

			<h2>Load a pulse</h2>
			<p>
				<code>createPulseResource</code> is <code>createResource</code> for a
				pulse: it loads the pulse of an ID, and again when the ID changes. JSX
				reads and writes it like any object: assignments and array methods go
				straight to the pulse, which syncs them to every peer.
			</p>
			<CodeBlock title="src/components/ProjectPage.tsx" code={load} />
			<p>
				Objects keep their identity, so <code>&lt;For&gt;</code> keeps its rows.
			</p>

			<h2>Create a pulse</h2>
			<p>
				<code>createPulse</code> is synchronous, so an event handler can create
				a pulse and show it at once. Keep it in a <code>createPulseSignal</code>
				, which makes the pulses it holds reactive.
			</p>
			<CodeBlock title="NewProject.tsx" code={create} />

			<h2>Wrap a pulse you already have</h2>
			<p>
				<code>createPulseResource</code> and <code>createPulseSignal</code> are
				shortcuts for one primitive, <code>createMutablePulse(pulse)</code>.
				Call it yourself for a pulse that comes from code that does not know
				Solid: a module shared with another app, a library, an editor binding.
			</p>
			<CodeBlock title="example.ts" code={wrap} />
			<p>
				It can be called anywhere, as often as needed: the view is created once
				per pulse, and its nested objects, arrays and sub-pulses are views too.
			</p>

			<h2>Presence</h2>
			<p>
				<code>createPulsePresence(pulse, Channel)</code> joins a{" "}
				<a href="/docs/presence">presence channel</a> of a pulse. Reads of its{" "}
				<code>others</code> and <code>mine</code> are tracked, and{" "}
				<code>set</code> publishes your state.
			</p>
			<CodeBlock title="Cursors.tsx" code={presence} />
			<p>
				It leaves the channel when its owner is disposed, as{" "}
				<code>onCleanup</code> does. A peer whose state did not change keeps the
				same object, so <code>&lt;For&gt;</code> keeps its row.
			</p>
			<p>
				It needs a connector that relays presence: Pulsify Cloud, or your own
				relay with <code>presence: true</code>.{" "}
				<a href="/docs/presence#where-it-works">Where it works →</a>
			</p>

			<NeverOnTheServer
				file="src/routes/projects/[id].tsx (SolidStart)"
				code={never}
			>
				The same goes for API routes, route preloads, and a component that
				SolidStart renders on the server, where a resource runs too:{" "}
				<code>createPulseResource</code> fails there. Import the components that
				load pulses with <code>clientOnly</code>:
			</NeverOnTheServer>
			<CodeBlock title="src/routes/projects/[id].tsx" code={route} />
		</>
	);
}
