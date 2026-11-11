import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { ClientOnly, NoteDefinition } from "~/components/Frontend";

const helper = `import { createSubscriber } from "svelte/reactivity";
import { subscribePulse, type Pulse } from "pulsify-core";

/** A view of the pulse whose reads Svelte tracks. Writes go to the pulse. */
export function pulseState<P extends Pulse<any>>(pulse: P): P {
  const track = createSubscriber((update) => subscribePulse(pulse, update));
  const views = new WeakMap<object, object>();
  const view = (value: object): object => {
    let proxy = views.get(value);
    if (!proxy) {
      proxy = new Proxy(value, {
        get(target, key) {
          track();
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

const editor = `<script lang="ts">
  import type { NotePulse } from "$lib/note";

  let { note }: { note: NotePulse } = $props();
</script>

<input bind:value={note.title} />
<p>by {note.author.name}</p>
<ul>
  {#each note.tags as tag}<li>{tag}</li>{/each}
</ul>
<button onclick={() => note.tags.push("new")}>Add tag</button>`;

const page = `<script lang="ts">
  import { onMount } from "svelte";
  import { disconnectPulse, loadPulse } from "pulsify-core";
  import { page } from "$app/state";
  import { Note, remote, type NotePulse } from "$lib/note";
  import { pulseState } from "$lib/pulseState";
  import Editor from "./Editor.svelte";

  let note = $state.raw<NotePulse>();

  // onMount never runs during server rendering.
  onMount(() => {
    let pulse: NotePulse | undefined;
    loadPulse(Note, page.params.id, { connectors: [remote] }).then((loaded) => {
      pulse = loaded;
      note = pulseState(loaded);
    });
    return () => pulse && disconnectPulse(pulse);
  });
</script>

{#if note}<Editor {note} />{:else}<p>Loading…</p>{/if}`;

const noSsr = `// src/routes/notes/[id]/+page.ts
export const ssr = false;`;

export default function Svelte() {
	return (
		<>
			<Title>Svelte · Docs</Title>
			<h1>Svelte</h1>
			<p>
				Wrap a pulse with a small helper built on Svelte's{" "}
				<code>createSubscriber</code>. Templates read and write it like any
				object, and remote changes update them.
			</p>

			<h2>The definition</h2>
			<NoteDefinition />

			<h2>The helper</h2>
			<CodeBlock title="src/lib/pulseState.ts" code={helper} />
			<p>
				Every template expression that reads the pulse re-runs after a change
				of that pulse, and Svelte only touches the DOM nodes whose value
				changed. Nested objects and arrays are wrapped too, so components
				receiving <code>note.author</code> or an item of{" "}
				<code>note.tags</code> stay up to date.
			</p>
			<Note>
				Do not use <code>$state(pulse)</code>: Svelte copies the object into
				its own state, so remote changes never show and writes never reach
				the pulse.
			</Note>

			<h2>Render and edit</h2>
			<CodeBlock title="Editor.svelte" code={editor} />
			<p>
				<code>bind:value</code>, assignments and array methods write straight
				to the pulse, which syncs them to every peer.
			</p>

			<h2>Load on the client</h2>
			<ClientOnly how="In SvelteKit, load the pulse in onMount, or turn server rendering off for the page." />
			<CodeBlock title="src/routes/notes/[id]/+page.svelte" code={page} />
			<p>Or render the whole page in the browser:</p>
			<CodeBlock title="src/routes/notes/[id]/+page.ts" code={noSsr} />
		</>
	);
}
