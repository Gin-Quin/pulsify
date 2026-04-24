# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Pulsify is a real-time collaborative data synchronization library inspired by Yjs, built with TypeScript. It provides performant, type-safe data structures (PulseArray, PulseObject, PulseValue) that automatically sync between clients using CRDTs (Conflict-free Replicated Data Types).

## Project Structure

This is a pnpm monorepo with two main packages:

- **`packages/pulse/`**: Core library implementing CRDT data structures
- **`packages/pulse-svelte/`**: Svelte 5 integration (SvelteKit demo app)

## Development Commands

### Testing
```bash
# Run all tests (uses Bun test runner)
cd packages/pulse
bun test

# Run tests in watch mode
bun run dev
```

### Linting
```bash
# Run Biome linter/formatter from root
pnpm exec biome check .
pnpm exec biome check --write .
```

### Svelte Demo
```bash
cd packages/pulse-svelte
pnpm dev           # Start dev server
pnpm build         # Build for production
pnpm check         # Type-check with svelte-check
```

## Architecture

### Core CRDT Implementation

The library implements a CRDT synchronization system based on logical clocks and actor IDs:

1. **Actor System** (`source/types/Actor.ts`): Each client has a unique 5-byte actor ID. Operations are tracked with `{actor: bigint, clock: bigint}` events.

2. **State Representation**: Each Pulse maintains:
   - `state`: Array of `Entries<T>` - the CRDT state as actor events with content
   - `stateVector`: Map of actor ID → highest clock value (for tracking what updates have been applied)
   - `pendingUpdates`: Queue of updates that arrived out-of-order

3. **Update Application** (`PulseState.ts`):
   - Updates carry `{actor, clock, content, left?, right?, key?}`
   - `left/right` provide ordering context for arrays
   - `applyUpdate()` handles clock comparison, deduplication, and conflict resolution
   - Out-of-order updates are queued and retried after gaps are filled

4. **Connectors** (`source/types/Connector.ts`): Simple interface `{send(Uint8Array): void}` for transmitting updates. Default connectors are globally configurable via `useConnectors()`.

### Key Data Structures

- **PulseArray** (`source/pulses/PulseArray.ts`): CRDT list with `insert()`, `push()`, `unshift()`, `splice()`. Uses left/right event positioning for conflict resolution. Extends native Array via class mixing.

- **PulseObject** (`source/pulses/PulseObject.ts`): CRDT map for key-value pairs.

- **PulseValue** (`source/pulses/PulseValue.ts`): Simple CRDT for single values with last-write-wins semantics.

- **PulseState** (`source/pulses/PulseState.ts`): Abstract base class providing synchronization logic, update application, connector management, and event emitter (`on/off/emit`).

### Important Patterns

1. **Actor ID Reusability**: Unlike Yjs, Pulse allows reusing client IDs to reduce memory/bandwidth overhead.

2. **Class Mixing**: PulseArray uses `@gin-quin/minimix` to extend both Array and PulseState simultaneously.

3. **Serialization**: Updates are serialized with `@digitak/bunker` for efficient binary encoding.

4. **Framework Integration**: Pulses expose `subscribe()` and `set()` for Svelte compatibility, making them work directly with Svelte's `$` syntax without additional wrappers.

## Testing Approach

Tests use randomized operations to verify CRDT correctness:
- Generate random sequences of insert/push/unshift operations
- Apply same operations to both PulseArray and native Array
- Assert values match after each operation
- See `packages/pulse/tests/index.test.ts` for examples

## Important Notes

- The codebase uses **Bun** as the primary runtime and test runner
- TypeScript paths use bare imports like `pulse/pulses/PulseArray` (configured in tsconfig.json)
- Biome is used for linting/formatting (not ESLint/Prettier)
- The project is in active development - some Pulse types (PulseMap, PulseSet, PulseString) are stubbed out
