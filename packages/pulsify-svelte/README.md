# pulsify-svelte

Svelte reactivity for Pulsify documents, with no dependency besides Svelte 5
and `pulsify-core`.

```svelte
<script lang="ts">
  import { loadSveltePulse } from "pulsify-svelte";
  import { Note } from "./note";

  let { id }: { id: string } = $props();
  // Top-level await needs `compilerOptions.experimental.async` in Svelte 5.
  const note = $derived(await loadSveltePulse(Note, id));
</script>

<input bind:value={note.title} />
<ul>
  {#each note.tags as tag}<li>{tag}</li>{/each}
</ul>
<button onclick={() => note.tags.push("new")}>Add tag</button>
```

`new SveltePulse(pulse)` returns a view of the live pulse whose reads Svelte
tracks, as `SvelteMap` does for a `Map`. Templates, `$derived` and `$effect`
that read it re-run after a local or remote change. Writes go straight to the
pulse.

- `await loadSveltePulse(definition, id, options?)` is
  `new SveltePulse(await loadPulse(…))`.
- `createSveltePulse(definition, input, options?)` is
  `new SveltePulse(createPulse(…))`.

- Nested objects, arrays and rich text are views too, so a component that
  receives `note.author` or an item of an array stays up to date.
- A sub-pulse read through a view, `handle.pulse`, is a view of the child,
  tracked on its own. `loadPulse` loads children with their parent; a
  child loaded later does not notify the readers of its parent.
- There is one view per pulse, so `new SveltePulse(pulse)` returns the same
  object every time, and it can be called anywhere: in a component, a module
  or an event handler. The pulse is subscribed to only while an effect reads
  it.
- Every reader of a pulse re-runs after a change of that pulse, and Svelte
  only touches the DOM whose value changed. Split very large documents into
  sub-pulses.
- Do not use `$state(pulse)`, and keep a view in `$state.raw`, not `$state`:
  Svelte copies what `$state` holds into its own state, so remote changes never
  show and writes never reach the pulse.
- Pulses live on the client: never create or load one during server
  rendering.

## Presence

```svelte
<script lang="ts">
  import { SveltePresence } from "pulsify-svelte";

  let { project } = $props();
  const cursors = new SveltePresence(project, Cursor); // a definePresence channel
</script>

<div onpointermove={(e) => cursors.set({ x: e.clientX, y: e.clientY })}>
  {#each cursors.others as { peer, state } (peer)}
    <i style:left="{state.x}px" style:top="{state.y}px"></i>
  {/each}
</div>
```

`new SveltePresence(pulse, channel)` joins the channel. Its `others` and
`mine` are tracked by templates, `$derived` and `$effect`; `set(state)`
publishes this session's state.

- Created while a component initializes, it leaves the channel when the
  component is destroyed. Created anywhere else, call `leave()` yourself.
- Joins are counted: several components can use the same channel.
