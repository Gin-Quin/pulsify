# Changelog

All notable changes to Pulsify are documented in this file.

## [Unreleased]

### Fixes

- **Live delivery**: a stored upload reaches every other session, whatever happens to one of them.
  - A grouped upload just under 8 MiB reached envelope 1 sessions of Pulsify Cloud and `PulseRelay` not at all: it now arrives as bounded `update` frames, in order, each with the committed vector. `encodeBroadcastFrames` (`pulsify-core/protocol`) makes them; `encodeBroadcast` is unchanged.
  - Pulsify Cloud encodes an update once per envelope instead of once per session.
  - The local server closes a socket whose frame Bun dropped (`send` answered 0) with 1013, so that its client reconnects and downloads what it missed.
  - The Rust `Hub` forwards stored rows even when the sender's own sink is gone; a retransmission stores nothing, so the other sessions never got them.

## [17.0.0]

### Performance

Every bottleneck found by the November 2026 review was removed; each fix has a regression test.

- **Storage**:
  - SQLite and PostgreSQL serve a lagging peer through a clock index: 4,000 values one row behind went from 5.3 s to 0.1 ms.
  - Downloads are paged from one read snapshot per page (`missingPage`, `streamStoreMessage`), so a 48 MiB document no longer peaks at 110 MiB.
  - Resending packed rows, appending behind pending rows and opening a current store no longer redo work.
- **Core model**:
  - Pastes, range deletes, remote keystrokes and inserts into arrays that were once moved are linear in what they change.
  - Tree reads are cached; fractional positions stay short when siblings are appended.
- **Runtime**:
  - Writes no longer walk the document to find `sub()` references.
  - Passive readers stay `synced`.
  - `PulseMap` caches its size and order, and React compares rich text by revision.
- **Journals and relays**:
  - The Rust journal appends without cloning itself.
  - Rows still waiting for their dependencies are no longer served or re-uploaded.
  - Relays encode a broadcast once per protocol version.
- **Editors**:
  - ProseMirror and Lexical reconcile only the blocks a change touches; a keystroke in 1,000 paragraphs went from about 100 ms to 1 ms.
  - Bindings ignore writes to other fields.
- **Connectors**:
  - IndexedDB uses one transaction per upload and per connect, and one queue per document.
  - Electron serves a file-backed store from a worker thread, with a main-thread fallback.
  - Tauri sends recovery frames as raw bytes.

### Breaking changes

- **Operations**: kinds 12 (text insertion with shared attributes) and 13 (range deletion) under operations version 3. A pasted character costs about one wire byte instead of 31; peers before 17 reject these rows. An editor edit over the 1 MiB patch limit is refused locally and reverted.
- **Relays**: a relay's sync `found` and `missing` follow the ready frontier: rows waiting for a dependency are no longer served.
- **Storage schema**: a `pulsify_values_clock` index is added to SQLite and PostgreSQL; PostgreSQL drops `pulsify_rows_frontier`. Both are applied when a store opens.
- **Tauri**: `mark_deleted` takes a raw length-prefixed body; update `pulsify-tauri` and `tauri-plugin-pulsify` together.
- **Sub-pulse refs**: `ref` objects of `sub()` fields are stable per slot, so `pulse.cover === pulse.cover`; two slots that name the same child no longer share one view handle.

## [16.0.0]

### Live sub-documents & `ref.pulse` reactivity

- **Proactive descendant push on Pulsify Cloud (`watch` / `unwatch`)**:
  - Servers advertise `watch: true` in the `welcome` frame (protocol session version unchanged; backward-compatible with older clients and servers).
  - Open parent pulses with `subPulses: true` send `{"type":"watch","docId"}` so the server pushes live broadcast updates (`update`, request ID `0`) for newly created or edited descendants (`docId/…`) that the socket is authorized to read.
  - Watched prefixes survive Cloudflare Durable Object hibernation in the socket attachment (with SQLite overflow in `pulsify_cloud_watches`) and are cleared on `unwatch`, grant revocation, deletion, or disconnect.
  - `CloudConnector` buffers pushed descendant rows (bounded by document count, byte budget, and TTL) and exposes `takePushed` / `onPushed` on the `Connector` interface.
- **Zero-RTT synchronous hydration & live auto-loading**:
  - When a connected parent pulse (`subPulses: true`) applies a remote update introducing a new `sub()` reference, it synchronously hydrates the child pulse from buffered pushed rows *before* notifying parent subscribers — eliminating intermediate `ref.pulse === undefined` states.
  - Falls back to automatic asynchronous loading on non-Cloud connectors, evicted buffers, or out-of-order writes (when a parent links a child ID before the child finishes uploading).
  - Parents loaded with `subPulses: false` remain strictly lazy (no server `watch`, no auto-load).
- **Reactive `ref.pulse` transitions**:
  - `PulseRef.pulse` only returns a pulse once `meta.loaded && !meta.deleted`, preventing reads of half-loaded instances.
  - Whenever a referenced sub-pulse enters or leaves the parent's scope (live auto-load, manual `ref.load()`, deletion, or destruction), the parent notifies its subscribers (`subscribePulse`), `createPulseViews` (Vue, Solid, Svelte), and React's `usePulse`.

### Write authors & per-account scopes

- **Actor-to-account binding & per-write sender tracking on Pulsify Cloud**:
  - Added `actors` / `authors` HTTP routes, `actors` control frames, and `authors` / `subject` fields in `welcome`.
  - `cloud.actorSubject(docId, actor)` and `cloud.authors(docId)` report which account claimed each actor and whether each transaction was sent directly by that account (`verified`).
  - `createPulseScope({ identity })` isolates actors per account and prevents cross-account synchronization on a single `CloudConnector`.
