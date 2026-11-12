# pulsify-react

Fine-grained React rendering for Pulsify documents, with no dependency besides
React and `pulsify-core`.

```tsx
import { usePulse } from "pulsify-react";
import { memo } from "react";

function Note({ note }: { note: typeof doc }) {
  const snap = usePulse(note);
  return (
    <>
      <input value={snap.title} onChange={(e) => (snap.title = e.target.value)} />
      <ul>{snap.items.map((item) => <Item key={item.label} item={item} />)}</ul>
    </>
  );
}

const Item = memo(({ item }: { item: (typeof doc)["items"][number] }) => (
  <li onClick={() => (item.done = !item.done)}>{item.label}</li>
));
```

`useLoadPulse(definition, id, options?)` loads a pulse under `<Suspense>`:

```tsx
function NotePage({ id }: { id: string }) {
  const note = useLoadPulse(Note, id); // suspends until loaded
  return <h1>{note.title}</h1>;
}
```

It returns a pulse loaded or created already at once, loads again when the ID
changes, and throws a failed load to the nearest error boundary, loading again
on the next render. Then it works as `usePulse`.

`usePulse(pulse)` returns a proxy of the live pulse that records what the
component reads. Local and remote changes re-render it only when one of those
values changed. Writes go straight to the pulse.

- Objects, arrays, rich text and trees keep their identity while nothing read
  below them changes, including after an array move, so `memo` children skip.
  A child reading a value it received records the read for the component that
  called `usePulse`.
- Rich text and trees are compared as a whole: their readers re-render when
  their content changes. Bind editors with `pulsify-prosemirror` or
  `pulsify-lexical`.
- The pulse itself is renewed on every render, so a `memo` child given the
  whole pulse renders with its parent. Pass it the part it shows, or let it
  call `usePulse` on what it received.
- A nested object passed to a skipped `memo` child keeps that child's reads
  until something below it changes, which costs at most one extra render.
- Pulses live on the client. During server rendering, both hooks throw and
  the nearest `<Suspense>` boundary renders its fallback, then the client
  renders the content.
- Do not write during render. Reads made in event handlers or effects are
  tracked too and can cause extra renders.

## Presence

```tsx
import { usePulsePresence } from "pulsify-react";

function Cursors({ project }: { project: ProjectPulse }) {
  const cursors = usePulsePresence(project, Cursor); // a definePresence channel
  return (
    <div onPointerMove={(e) => cursors.set({ x: e.clientX, y: e.clientY })}>
      {cursors.others.map(({ peer, state }) => (
        <i key={peer} style={{ left: state.x, top: state.y }} />
      ))}
    </div>
  );
}
```

`usePulsePresence(pulse, channel)` joins the channel while the component is
mounted and returns `{ others, mine, set }`. The component re-renders when
the others or its own state change, not when the document does. A peer whose
state did not change keeps the same object, so `memo` children skip.

- `set` keeps its identity between renders, while the pulse and the channel
  stay the same. Call it from handlers and
  effects, never during render. A state set by a child's effect before the
  channel is joined is kept and sent.
- Joins are counted: several components can use the same channel, and the
  state is removed when the last one unmounts.
- Like `usePulse`, it renders on the client only.
