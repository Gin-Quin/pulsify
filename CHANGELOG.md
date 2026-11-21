# Changelog

All notable changes to Pulsify are documented in this file.

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
