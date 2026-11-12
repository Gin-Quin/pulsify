import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { DefaultConnectors, NeverOnTheServer } from "~/components/Frontend";

const install = `bun add pulsify-core pulsify-vue`;

const load = `<script setup lang="ts">
import { loadReactivePulse } from "pulsify-vue";
// Project has documents: array(sub(Document)).
import { Project } from "./project";

const props = defineProps<{ id: string }>();

// Loaded with its sub-pulses.
const project = await loadReactivePulse(Project, props.id);
</script>

<template>
  <input v-model="project.name" />
  <ul>
    <li v-for="document in project.documents" :key="document.id">
      {{ document.pulse?.title }}
    </li>
  </ul>
  <button @click="project.documents.pop()">Remove the last one</button>
</template>`;

const suspense = `<template>
  <Suspense>
    <!-- :key loads again when the ID changes. -->
    <ProjectPage :id="id" :key="id" />
    <template #fallback><p>Loading…</p></template>
  </Suspense>
</template>`;

const create = `<script setup lang="ts">
import { shallowRef } from "vue";
import { createReactivePulse } from "pulsify-vue";
import { Project, type ProjectPulse } from "./project";

const project = shallowRef<ProjectPulse>();

function create() {
  project.value = createReactivePulse(Project, { name: "Untitled", documents: [] });
}
</script>

<template>
  <button @click="create">New project</button>
  <input v-if="project" v-model="project.name" />
</template>`;

const wrap = `import { loadPulse } from "pulsify-core";
import { reactivePulse } from "pulsify-vue";
import { Project } from "./project";

// A plain pulse: what reads it never re-renders.
const pulse = await loadPulse(Project, id);

// The reactive view of that pulse. A write to either one reaches the same
// document and re-renders what reads the view.
const project = reactivePulse(pulse);

reactivePulse(pulse) === project; // true: one view per pulse
reactivePulse(project) === project; // true: a view is returned as is`;

const presence = `<script setup lang="ts">
import { usePulsePresence } from "pulsify-vue";
import { Cursor } from "./presence";
import type { ProjectPulse } from "./project";

const props = defineProps<{ project: ProjectPulse }>();

// Joins now, leaves when the component is unmounted.
const cursors = usePulsePresence(props.project, Cursor);
</script>

<template>
  <div
    class="board"
    @pointermove="cursors.set({ x: $event.clientX, y: $event.clientY })"
    @pointerleave="cursors.set(undefined)"
  >
    <i
      v-for="{ peer, state } in cursors.others"
      :key="peer"
      class="cursor"
      :style="{ left: state.x + 'px', top: state.y + 'px' }"
    />
  </div>
</template>`;

const never = `<script setup lang="ts">
import { loadPulse, snapshotPulse } from "pulsify-core";
import { Project } from "~/project";

const route = useRoute();
// DANGEROUS: useAsyncData runs on the server.
const { data: project } = await useAsyncData("project", async () =>
  snapshotPulse(await loadPulse(Project, route.params.id as string)),
);
</script>`;

const clientOnly = `<template>
  <ClientOnly fallback="Loading…">
    <Suspense>
      <ProjectPage :id="id" :key="id" />
    </Suspense>
  </ClientOnly>
</template>`;

export default function Vue() {
	return (
		<>
			<Title>Vue · Docs</Title>
			<h1>Vue</h1>
			<p>
				<code>pulsify-vue</code> makes pulses reactive, as <code>reactive</code>{" "}
				does for a plain object: what reads them re-renders after a local or
				remote change.
			</p>
			<CodeBlock title="terminal" code={install} />

			<DefaultConnectors file="src/main.ts" />

			<h2>Load a pulse</h2>
			<p>
				Await <code>loadReactivePulse</code> directly in{" "}
				<code>&lt;script setup&gt;</code>. Templates read and write the pulse
				like any object: <code>v-model</code>, assignments and array methods go
				straight to the pulse, which syncs them to every peer.
			</p>
			<CodeBlock title="ProjectPage.vue" code={load} />
			<p>
				A sub-pulse read through the project, <code>document.pulse</code>, is
				reactive too. A component that awaits renders under{" "}
				<code>&lt;Suspense&gt;</code>, which shows a placeholder while it loads:
			</p>
			<CodeBlock title="App.vue" code={suspense} />

			<h2>Create a pulse</h2>
			<p>
				<code>createReactivePulse</code> is synchronous, so an event handler can
				create a pulse and show it at once.
			</p>
			<CodeBlock title="NewProject.vue" code={create} />
			<Note kind="warn">
				Do not pass a pulse to <code>reactive</code> or <code>ref</code>. Vue
				does not proxy pulse objects: it returns the pulse unchanged and nothing
				re-renders. Use <code>reactivePulse</code>.
			</Note>

			<h2>Wrap a pulse you already have</h2>
			<p>
				<code>loadReactivePulse</code> and <code>createReactivePulse</code> are
				shortcuts for one primitive, <code>reactivePulse(pulse)</code>. Call it
				yourself for a pulse that comes from code that does not know Vue: a
				module shared with another app, a library, an editor binding.
			</p>
			<CodeBlock title="example.ts" code={wrap} />
			<p>
				It can be called anywhere, as often as needed: the view is created once
				per pulse, and its nested objects, arrays and sub-pulses are views too.
			</p>

			<h2>Presence</h2>
			<p>
				<code>usePulsePresence(pulse, Channel)</code> joins a{" "}
				<a href="/docs/presence">presence channel</a> of a pulse. Reads of its{" "}
				<code>others</code> and <code>mine</code> are tracked, and{" "}
				<code>set</code> publishes your state.
			</p>
			<CodeBlock title="Cursors.vue" code={presence} />
			<p>
				Called in <code>setup</code>, it leaves the channel when the component
				is unmounted. Read <code>cursors.others</code> where you need it rather
				than destructuring it, as with <code>reactive</code>.
			</p>
			<p>
				It needs a connector that relays presence: Pulsify Cloud, or your own
				relay with <code>presence: true</code>.{" "}
				<a href="/docs/presence#where-it-works">Where it works →</a>
			</p>

			<NeverOnTheServer file="pages/projects/[id].vue (Nuxt)" code={never}>
				The same goes for server routes, plugins, and a component that Nuxt
				renders on the server, where a top-level <code>await</code> runs too.
				Render the components that load pulses in the browser only:
			</NeverOnTheServer>
			<CodeBlock title="pages/projects/[id].vue" code={clientOnly} />
		</>
	);
}
