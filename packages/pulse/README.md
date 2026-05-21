# Pulse

**Pulse** is an hyper-optimized and simple syncing library for Typescript. It can be used in any JS environment, browser, Bun, Deno or Node, and is compatible with frontend frameworks like Svelte 5 and Solid.

Internally, it uses [json-joy](https://jsonjoy.com/) as the underlying CRDT library. **json-joy** is a very fast and low-level TypeScript implementation of the CRDT algorithm.

## Usage

A `pulse` is a wrapper around a JSON value (primitive, array or object) that can be synchronized between different **connections**.

A **connection** can be one or more browsers, a server, a local database, a distant database, etc.

Every pulse is assigned a unique id.


### Create a Pulse

Before using a pulse, you need to define its type.

For example, let's create an `User` pulse with fields `name` and `email`:

```ts
export type User = PulseProperties<"User"> & {
	name: string;
	email: string;
}

export const User = definePulse<User>().materialize()
```

This is the simplest Pulse type:

- no migrations
- no materializer

We'll see later how to add migrations and what a materializer used for.

### Use a pulse

Now, we can create user pulses:

```ts
import { User } from "./User.ts"
import { createPulse } from "@pulsify/core"

const me = createPulse(User, {
	kind: "User",
	name: "John",
	email: "john@doe.com",
})

console.log("id:", me.id)
console.log("name:", me.name)
console.log("email:", me.email)
```

### Adding connectors

When creating a pulse, the pulse will automatically connect with all default connectors.

By default, no connectors are specified.

If you want to save your object locally in IndexedDB, just register the IndexedDBConnector:

```ts
import { setDefaultPulseOptions } from "@pulsify/core"
import { IndexedDBConnector } from "@pulsify/connector-indexeddb"

setDefaultPulseOptions(
	connectors: [
		IndexedDBConnector,
	],
)
```

Now, by default, all pulses will be automatically saved to IndexedDB.

When loading a pulse from its id, it will be loaded from IndexedDB as well.

### Other default options

```ts
type PulseOptions = {
	/**
	 * The function used to auto-generate a pulse id
	 */
	createId: () => string;

	/**
	 * Whether to automatically connect when a pulse is created
	 */
	connect: boolean;

	/**
	 * The list of default connectors for new and loaded pulses
	 */
	connectors: Array<Connector>;
}
```

### Pulse objects

```ts
const pulse = createPulse(MyPulseObject, {
	x: 12,
	y: 132,
	nasty: {
		z: 213
	},
	values: [4, 0, 123],
	tuple: Tuple(4, 1, 34),
	record: Record({ name: "John", age: 32 }),
	tree: PulseTree(),
});
```

### Loading a pulse

When you want to load a pulse from another client (for example, your local database), you can use the `loadPulse` function:

```ts
const user = await loadPulse(User, id);

// optionally, you can specify the connections to use to load the pulse
const user = await loadPulse(User, id, {
	connectors: [localDBConnector, externalDBConnector, peerToPeerConnector],
});
```

The pulse is considered loaded the **first time** a client answers the request. This does not mean that the pulse has the most recent value. For example, if your pulse is connected to both a local database and a distant database:

1. The local database will load the pulse first because there is no latency
2. The pulse is considered "loaded" but maybe the distant database has the most recent value
3. The pulse will be automatically updated when the synchronization to the distant database is complete

You can control when a pulse is considered loaded by using the `waitFor` option:

```ts
const count = await loadPulse(User, id, {
	waitFor: [
		externalDBConnection, // wait for the pulse to be synced from the external database
	],
});

const count = await loadPulse(id, {
	waitFor: "all", // wait for all the connections to be synced
});
```

This is useful if you never want to show stale data to the user, but you lose some performance.

### Sub-pulses

## Using pulses with a frontend framework

To bring reactivity, pulses have lightweight integrations for the most popular frontend frameworks:

- [Svelte](https://github.com/pulsify-dev/pulsify-svelte)
- [Solid](https://github.com/pulsify-dev/pulsify-solid)
- [Vue](https://github.com/pulsify-dev/pulsify-vue)
- [React](https://github.com/pulsify-dev/pulsify-react) using [@preact/signals-react](https://preactjs.com/docs/signals)
- [React](https://github.com/pulsify-dev/pulsify-react) using regular states

> If you want to use React, we strongly recommend using [@preact/signals](https://preactjs.com/docs/signals) as the component rendering engine, as it is much more performant and have greater compatibility with pulses.

## Pulses with Svelte

For Svelte, you can use the `$pulse` rune to create a pulse:

```svelte
<script lang="ts">
  import { $pulse } from "@pulsify/svelte"

  let count = $pulse(0)
</script>

My pulse is {count}

<button on:click={() => count++}>
  Increment
</button>
```

### Alternative syntax (compatible with Svelte 4)

Since pulses have the `subscribe` and `set` methods, they can be used directly in both Svelte 5 or Svelte 4 components using the `$` syntax, without having to install any additional package:

```svelte
<script lang="ts">
  import { createPulse } from "@pulsify/core"

  const count = createPulse(0)
</script>

<p>
  Count: {$count}
</p>

<button on:click={() => $count++}>
  Increment
</button>
```

### Pulses with Solid

SolidJS is an awesome alternative to React that internally uses signals to bring reactivity to the platform.

```tsx
import { pulseSignal } from "@pulsify/solid";

export function Counter() {
	const [count, setCount] = pulseSignal(0);

	return (
		<div>
			<p>Count: {count()}</p>

			<button onClick={() => setCount(count() + 1)}>Increment</button>
		</div>
	);
}
```

### Pulses with Vue

Vue is a popular frontend framework that uses reactivity to bring reactivity to the platform.

To have a reactive pulse, simply wrap your pulse with the `reactive` keyword:

```vue
<script setup lang="ts">
import { createPulse } from "@pulsify/core";

const count = reactive(createPulse({
  id: "jk****************sd",
  value: 0,
}))
</script>

<template>
	<p>Count: {count.value}</p>

	<button on:click="{()" ="">count.value++}> Increment</button>
</template>
```

### Pulses with React (using @preact/signals)

`@preact/signals` is a library fully compatible with React that uses signals, which solves most of React's issues with reactivity.

```tsx
import { pulseSignal } from "@pulsify/preact";

export function Counter() {
	const count = pulseSignal(0);

	return (
		<div>
			<p>Count: {count.value}</p>

			<button onClick={() => count.value++}>Increment</button>
		</div>
	);
}
```

### Pulses with React

```tsx
import { usePulse } from "@pulsify/react";

export function Counter() {
	const count = usePulse({
    id: "za******************kj",
    value: 0,
  });

	return (
		<div>
			<p>Count: {count}</p>

			<button onClick={() => count.value++}>Increment</button>
		</div>
	);
}
```
