# pulsify-vue

Vue reactivity for Pulsify documents, with no dependency besides Vue 3 and
`pulsify-core`.

```vue
<script setup lang="ts">
import { loadReactivePulse } from "pulsify-vue";
import { Note } from "./note";

const props = defineProps<{ id: string }>();
// Top-level await: render this component under <Suspense>.
const note = await loadReactivePulse(Note, props.id);
</script>

<template>
  <input v-model="note.title" />
  <ul>
    <li v-for="(tag, i) in note.tags" :key="i">{{ tag }}</li>
  </ul>
  <button @click="note.tags.push('new')">Add tag</button>
</template>
```

`reactivePulse(pulse)` returns a view of the live pulse whose reads Vue tracks,
as `reactive` does for a plain object. Templates, `computed` and watchers that
read it re-run after a local or remote change. Writes go straight to the pulse.

- `await loadReactivePulse(definition, id, options?)` is
  `reactivePulse(await loadPulse(…))`.
- `createReactivePulse(definition, input, options?)` is
  `reactivePulse(createPulse(…))`.

- Nested objects, arrays and rich text are views too, so a component that
  receives `note.author` or an item of an array stays up to date.
- A sub-pulse read through a view, `handle.pulse`, is a view of the child,
  tracked on its own. `loadPulse` loads children with their parent; a
  child loaded later does not notify the readers of its parent.
- There is one view per pulse and `reactivePulse` can be called anywhere: in
  `setup`, a module or an event handler. It follows the pulse until
  `destroyPulse`.
- Every reader of a pulse re-runs after a change of that pulse, and Vue only
  patches the DOM that changed. Split very large documents into sub-pulses.
- Do not use `reactive(pulse)` or `ref(pulse)`: Vue does not proxy pulse
  objects, so nothing re-renders. A view can be kept in a `ref` or a
  `shallowRef`.
- Pulses live on the client: never create or load one during server
  rendering.

## Presence

```vue
<script setup lang="ts">
import { usePulsePresence } from "pulsify-vue";

const props = defineProps<{ project: ProjectPulse }>();
const cursors = usePulsePresence(props.project, Cursor); // a definePresence channel
</script>

<template>
  <div @pointermove="cursors.set({ x: $event.clientX, y: $event.clientY })">
    <i v-for="{ peer, state } in cursors.others" :key="peer"
       :style="{ left: state.x + 'px', top: state.y + 'px' }" />
  </div>
</template>
```

`usePulsePresence(pulse, channel)` joins the channel and returns an object
whose `others` and `mine` are tracked, with `set(state)` and `leave()`.

- Read `cursors.others` where you need it rather than destructuring it, as
  with `reactive`.
- Called in `setup` or any effect scope, it leaves the channel when the scope
  is disposed. Called elsewhere, call `leave()` yourself.
- Joins are counted: several components can use the same channel.
