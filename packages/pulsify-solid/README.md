# pulsify-solid

Solid reactivity for Pulsify documents, with no dependency besides Solid and
`pulsify-core`.

```tsx
import { For, Show } from "solid-js";
import { createPulseResource } from "pulsify-solid";
import { Note } from "./note";

export function NotePage(props: { id: string }) {
  const [note] = createPulseResource(Note, () => props.id);
  return (
    <Show when={note()} fallback={<p>Loading…</p>}>
      {(note) => (
        <>
          <input value={note().title} onInput={(e) => (note().title = e.currentTarget.value)} />
          <ul>
            <For each={note().tags}>{(tag) => <li>{tag}</li>}</For>
          </ul>
          <button onClick={() => note().tags.push("new")}>Add tag</button>
        </>
      )}
    </Show>
  );
}
```

`createPulseResource(definition, id, options?)` is `createResource` for a
pulse: it loads the pulse of an ID, and again when the ID changes.
`createPulseSignal()` is a signal for a pulse you create. Both hold the view
that `createMutablePulse(pulse)` returns: a view of the live pulse whose reads
Solid tracks, as `createMutable` does for a plain object. JSX, memos and effects
that read it re-run after a local or remote change. Writes go straight to the
pulse.

- Nested objects, arrays and rich text are views too, so a component that
  receives `note.author` or an item of an array stays up to date. They keep
  their identity, so `<For>` keeps its rows.
- A sub-pulse read through a view, `handle.pulse`, is a view of the child,
  tracked on its own. `loadPulse` loads children with their parent; a
  child loaded later does not notify the readers of its parent.
- There is one view per pulse and `createMutablePulse` can be called anywhere:
  in a component, a module or an event handler. It follows the pulse until
  `destroyPulse`.
- Every reader of a pulse re-runs after a change of that pulse, and Solid only
  touches the DOM whose value changed. Split very large documents into
  sub-pulses.
- Pulses live on the client: never create or load one during server
  rendering. `createPulseResource` fails on the server.

## Presence

```tsx
import { createPulsePresence } from "pulsify-solid";

function Cursors(props: { project: ProjectPulse }) {
  const cursors = createPulsePresence(props.project, Cursor); // a definePresence channel
  return (
    <div onPointerMove={(e) => cursors.set({ x: e.clientX, y: e.clientY })}>
      <For each={cursors.others}>
        {({ state }) => <i style={{ left: `${state.x}px`, top: `${state.y}px` }} />}
      </For>
    </div>
  );
}
```

`createPulsePresence(pulse, channel)` joins the channel and returns an object
whose `others` and `mine` are tracked, with `set(state)` and `leave()`.

- Created under an owner (a component, a root), it leaves the channel when
  the owner is disposed. Created elsewhere, call `leave()` yourself.
- A peer whose state did not change keeps the same object, so `<For>` keeps
  its row.
- Joins are counted: several components can use the same channel.
