import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { ClientOnly, NoteDefinition } from "~/components/Frontend";

const helper = `import { onScopeDispose, shallowRef } from "vue";
import { subscribePulse, type Pulse } from "pulsify-core";

/** A view of the pulse whose reads Vue tracks. Writes go to the pulse. */
export function usePulse<P extends Pulse<any>>(pulse: P): P {
  const version = shallowRef(0);
  onScopeDispose(subscribePulse(pulse, () => version.value++));
  const views = new WeakMap<object, object>();
  const view = (value: object): object => {
    let proxy = views.get(value);
    if (!proxy) {
      proxy = new Proxy(value, {
        get(target, key) {
          if (key === "__v_skip") return true; // never wrapped by reactive()
          void version.value;
          const item = Reflect.get(target, key);
          return typeof item === "object" && item !== null && !ArrayBuffer.isView(item)
            ? view(item)
            : item;
        },
      });
      views.set(value, proxy);
    }
    return proxy;
  };
  return view(pulse) as P;
}`;

const editor = `<script setup lang="ts">
import { usePulse } from "./usePulse";
import type { NotePulse } from "./note";

const props = defineProps<{ pulse: NotePulse }>();
const note = usePulse(props.pulse);
</script>

<template>
  <input v-model="note.title" />
  <p>by {{ note.author.name }}</p>
  <ul>
    <li v-for="(tag, i) in note.tags" :key="i">{{ tag }}</li>
  </ul>
  <button @click="note.tags.push('new')">Add tag</button>
</template>`;

const page = `<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef } from "vue";
import { disconnectPulse, loadPulse } from "pulsify-core";
import Editor from "./Editor.vue";
import { Note, remote, type NotePulse } from "./note";

const props = defineProps<{ id: string }>();
// shallowRef: Vue must not wrap the pulse in its own reactive proxy.
const pulse = shallowRef<NotePulse>();

// onMounted never runs during server rendering.
onMounted(async () => {
  pulse.value = await loadPulse(Note, props.id, { connectors: [remote] });
});
onUnmounted(() => pulse.value && disconnectPulse(pulse.value));
</script>

<template>
  <Editor v-if="pulse" :key="id" :pulse="pulse" />
  <p v-else>Loading…</p>
</template>`;

const nuxt = `<!-- Nuxt: or skip server rendering for the whole subtree -->
<ClientOnly fallback="Loading…">
  <NotePage :id="id" />
</ClientOnly>`;

export default function Vue() {
	return (
		<>
			<Title>Vue · Docs</Title>
			<h1>Vue</h1>
			<p>
				Wrap a pulse with a small composable. Templates read it, bind it with{" "}
				<code>v-model</code> and call its array methods, and remote changes
				re-render them.
			</p>

			<h2>The definition</h2>
			<NoteDefinition />

			<h2>The composable</h2>
			<CodeBlock title="usePulse.ts" code={helper} />
			<p>
				Every component that reads the pulse, directly or through an object it
				received as a prop, re-renders after a change of that pulse. Vue then
				patches only the DOM that changed. Split very large documents into
				sub-pulses.
			</p>
			<Note>
				Do not use <code>reactive(pulse)</code> or <code>ref(pulse)</code>: Vue
				does not proxy pulse objects, so it returns the pulse unchanged and
				nothing re-renders, not even after a local write.
			</Note>

			<h2>Render and edit</h2>
			<CodeBlock title="Editor.vue" code={editor} />

			<h2>Load on the client</h2>
			<ClientOnly how="In Vue and Nuxt, load the pulse in onMounted." />
			<CodeBlock title="NotePage.vue" code={page} />
			<CodeBlock title="pages/notes/[id].vue" code={nuxt} />
		</>
	);
}
