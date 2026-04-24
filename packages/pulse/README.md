# Pulse

Pulse is an hyper-optimized and simple syncing library for Typescript. It can be used in any JS environment, browser, Bun, Deno or Node, and is compatible with frontend frameworks like Svelte 5 and Solid.

## Usage

A `pulse` is a wrapper around a JSON value (primitive, array or object) that can be synchronized between different **connections**.

A **connection** can be one or more browsers, a server, a local database, a distant database, etc.

Every pulse is assigned a unique id.

### Pulse primitives

```ts
import { pulse } from "@pulsify/core"

const count = createPulse<number>(0, {
  id: createUniqueId(), // the id of the pulse
  synchronize: true, // set to true to start synchronizing the pulse
  authenticationToken: "my-authentication-token", // the authentication token to use to synchronize the pulse
  connections: [ // the connections to use to synchronize the pulse
    localDBConnection,
    peerToPeerConnection,
    externalDBConnection,
  ]
})

// all the parameters can be set globally, so you can simply create a pulse this way:
const count = createPulse(0)

// you can subscribe to changes that come from any connected client
count.subscribe((value) => {
  console.log(value)
})

// and programmatically update the pulse value
count.set(1)
count.update((value) => value + 1)
```


### Pulse objects

### Loading a pulse

When you want to load a pulse from another client (for example, your local database), you can use the `loadPulse` function:

```ts
const count = await loadPulse(id)

// optionally, you can specify the connections to use to load the pulse
const count = await loadPulse(id, {
  connections: [
    localDBConnection,
    externalDBConnection,
    peerToPeerConnection,
  ]
})
```

The pulse is considered loaded the **first time** a client answers the request. This does not mean that the pulse has the most recent value. For example, if your pulse is connected to both a local database and a distant database:

1. The local database will load the pulse first because there is no latency
2. The pulse is considered "loaded" but maybe the distant database has the most recent value
3. The pulse will be automatically updated when the synchronization to the distant database is complete

You can control when a pulse is considered loaded by using the `waitFor` option:

```ts
const count = await loadPulse(id, {
  waitFor: [
    externalDBConnection, // wait for the pulse to be loaded from the external database
  ], 
})

const count = await loadPulse(id, {
  waitFor: "all", // wait for all the connections to be loaded
})
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
import { pulseSignal } from "@pulsify/solid"

export function Counter() {
  const [count, setCount] = pulseSignal(0)

  return (
    <div>
      <p>Count: {count()}</p>

      <button onClick={() => setCount(count() + 1)}>
        Increment
      </button>
    </div>
  )
}
```

### Pulses with Vue

Vue is a popular frontend framework that uses reactivity to bring reactivity to the platform.

```vue
<script setup lang="ts">
  import { pulseRef } from "@pulsify/vue"

  const count = pulseRef(0)
</script>

<template>
  <p>
    Count: {count.value}
  </p>

  <button on:click={() => count.value++}>
    Increment
  </button>
</template>
```

### Pulses with React (using @preact/signals)

`@preact/signals` is a library fully compatible with React that uses signals, which solves most of React's issues with reactivity.

```tsx
import { pulseSignal } from "@pulsify/preact"

export function Counter() {
  const count = pulseSignal(0)

  return (
    <div>
      <p>Count: {count.value}</p>

      <button onClick={() => count.value++}>
        Increment
      </button>
    </div>
  )
}
```

### Pulses with React (using regular states - not recommended)

React is both the most popuplar and slowest frontend framework. Think twice before using it, that's not because everyone uses it that you have to do the same, there are better alternatives.

As a freelance software engineer, companies spent tens of thousands of dollars asking me to solve their React performance issues. It happened so often in my career that I found a name for this special kind of software engineering: "babysitting React". If these companies had chosen almost any other frontend framework, they would have saved a lot of time and money.

If you want an awesome alternative with 100% React compatibility, go for [@preact/signals](https://preactjs.com/docs/signals).

If you still want to use old and slow React, this is how to do it:

```tsx
import { usePulse } from "@pulsify/react"

export function Counter() {
  const [count, setCount] = usePulse(0)

  return (
    <div>
      <p>Count: {count}</p>

      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </div>
  )
}
```

## Reusing client ID

Having the ability to reuse a client ID is a super power compared to YJS. It enables **drastic** performance and memory improvements.


