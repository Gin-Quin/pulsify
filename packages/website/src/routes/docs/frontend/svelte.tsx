import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { DefaultConnectors, NeverOnTheServer } from "~/components/Frontend";

const install = `bun add pulsify-core pulsify-svelte`;

const config = `export default {
  compilerOptions: { experimental: { async: true } }, // await in components
};`;

const load = `<script lang="ts">
  import { loadSveltePulse } from "pulsify-svelte";
  import { page } from "$app/state";
  // Project has documents: array(sub(Document)).
  import { Project } from "$lib/project";

  // Loaded with its sub-pulses, and again when the ID changes.
  const project = $derived(await loadSveltePulse(Project, page.params.id));
</script>

<input bind:value={project.name} />
<ul>
  {#each project.documents as document (document.id)}
    <li>{document.pulse?.title}</li>
  {/each}
</ul>
<button onclick={() => project.documents.pop()}>Remove the last one</button>`;

const create = `<script lang="ts">
  import { createSveltePulse } from "pulsify-svelte";
  import { Project, type ProjectPulse } from "$lib/project";

  // $state.raw, not $state: Svelte must not copy the pulse into its own state.
  let project = $state.raw<ProjectPulse>();

  function create() {
    project = createSveltePulse(Project, { name: "Untitled", documents: [] });
  }
</script>

<button onclick={create}>New project</button>
{#if project}
  <input bind:value={project.name} />
{/if}`;

const wrap = `import { loadPulse } from "pulsify-core";
import { SveltePulse } from "pulsify-svelte";
import { Project } from "$lib/project";

// A plain pulse: what reads it never re-renders.
const pulse = await loadPulse(Project, id);

// The reactive view of that pulse. A write to either one reaches the same
// document and re-renders what reads the view.
const project = new SveltePulse(pulse);

new SveltePulse(pulse) === project; // true: one view per pulse
new SveltePulse(project) === project; // true: a view is returned as is`;

const presence = `<script lang="ts">
  import { SveltePresence } from "pulsify-svelte";
  import { Cursor } from "$lib/presence";
  import type { ProjectPulse } from "$lib/project";

  let { project }: { project: ProjectPulse } = $props();

  // Joins now, leaves when the component is destroyed.
  const cursors = new SveltePresence(project, Cursor);
</script>

<div
  class="board"
  onpointermove={(e) => cursors.set({ x: e.clientX, y: e.clientY })}
  onpointerleave={() => cursors.set(undefined)}
>
  {#each cursors.others as { peer, state } (peer)}
    <i class="cursor" style:left="{state.x}px" style:top="{state.y}px"></i>
  {/each}
</div>`;

const never = `import { loadPulse, snapshotPulse } from "pulsify-core";
import { Project } from "$lib/project";

// DANGEROUS: a load function runs on the server.
export async function load({ params }) {
  const project = await loadPulse(Project, params.id);
  return { project: snapshotPulse(project) };
}`;

const noSsr = `export const ssr = false;`;

export default function Svelte() {
	return (
		<>
			<Title>Svelte · Docs</Title>
			<h1>Svelte</h1>
			<p>
				<code>pulsify-svelte</code> makes pulses reactive, as{" "}
				<code>SvelteMap</code> does for a <code>Map</code>: what reads them
				re-renders after a local or remote change.
			</p>
			<CodeBlock title="terminal" code={install} />

			<DefaultConnectors file="src/hooks.client.ts" />

			<h2>Load a pulse</h2>
			<p>
				Await <code>loadSveltePulse</code> directly in the component. Templates
				read and write the pulse like any object: <code>bind:value</code>,
				assignments and array methods go straight to the pulse, which syncs them
				to every peer.
			</p>
			<CodeBlock title="src/routes/projects/[id]/+page.svelte" code={load} />
			<p>
				A sub-pulse read through the project, <code>document.pulse</code>, is
				reactive too. In Svelte 5, <code>await</code> in a component needs the
				async option; a <code>&lt;svelte:boundary&gt;</code> with a{" "}
				<code>pending</code> snippet shows a placeholder while it loads.
			</p>
			<CodeBlock title="svelte.config.js" code={config} />

			<h2>Create a pulse</h2>
			<p>
				<code>createSveltePulse</code> is synchronous, so an event handler can
				create a pulse and show it at once.
			</p>
			<CodeBlock title="NewProject.svelte" code={create} />
			<Note kind="warn">
				Never pass a pulse to <code>$state</code>, wrapped or not. Svelte copies
				what <code>$state</code> holds into its own state: remote changes never
				show and writes never reach the pulse. Use <code>SveltePulse</code>, and{" "}
				<code>$state.raw</code> for a variable that holds one.
			</Note>

			<h2>Wrap a pulse you already have</h2>
			<p>
				<code>loadSveltePulse</code> and <code>createSveltePulse</code> are
				shortcuts for one primitive, <code>new SveltePulse(pulse)</code>. Call
				it yourself for a pulse that comes from code that does not know Svelte:
				a module shared with another app, a library, an editor binding.
			</p>
			<CodeBlock title="example.ts" code={wrap} />
			<p>
				It can be called anywhere, as often as needed: the view is created once
				per pulse, and its nested objects, arrays and sub-pulses are views too.
			</p>

			<h2>Presence</h2>
			<p>
				<code>new SveltePresence(pulse, Channel)</code> joins a{" "}
				<a href="/docs/presence">presence channel</a> of a pulse. Its{" "}
				<code>others</code> and <code>mine</code> are reactive, and{" "}
				<code>set</code> publishes your state.
			</p>
			<CodeBlock title="Cursors.svelte" code={presence} />
			<p>
				Created in a component, it leaves the channel when the component is
				destroyed. Created anywhere else, call <code>leave()</code> yourself.
			</p>
			<p>
				It needs a connector that relays presence: Pulsify Cloud, or your own
				relay with <code>presence: true</code>.{" "}
				<a href="/docs/presence#where-it-works">Where it works →</a>
			</p>

			<NeverOnTheServer
				file="src/routes/projects/[id]/+page.server.ts"
				code={never}
			>
				The same goes for <code>+page.ts</code>, <code>+layout.ts</code>, hooks,
				and a component that SvelteKit renders on the server, where a top-level{" "}
				<code>await</code> runs too. Turn server rendering off for the pages
				that show pulses:
			</NeverOnTheServer>
			<CodeBlock title="src/routes/projects/[id]/+page.ts" code={noSsr} />
		</>
	);
}
