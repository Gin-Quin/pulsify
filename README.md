# Pulsify

Typed collaborative documents for TypeScript, with a versioned binary protocol usable from other languages.

The core uses `json-joy` for CRDT application and `@gin-quin/codec` **2.1.0** for binary messages and operation payloads. Connectors exchange bytes and portable version vectors rather than JavaScript engine objects. A dependency-free Rust crate implements the outer protocol and an opaque operation journal.

```sh
bun install --frozen-lockfile
bun run check                 # TypeScript, API, wire fixtures, convergence, WebSocket, lifecycle
bun run test:rust             # Rust protocol fixtures and journal
bun run test:interop          # TypeScript ↔ Rust, including real document synchronization
bun run build                 # Browser-compatible ESM + declarations
bun run test:package          # Packed tarball: strict NodeNext types and Node runtime
bun x --no-install playwright install chromium
bun run test:example          # Two real browser tabs, offline edits and reconnection
bun run test:runtimes         # Built package: Bun, Node 22+, Deno 2, Chromium
bun run test:codec-local      # Isolated build against ../codec, without changing either repository
bun run bench                 # Reproducible performance report
bun run bench:crdt            # Pulsify / native json-joy / Yjs / Loro, including proxy overhead
bun run dev                   # Two-tab WebSocket example at http://127.0.0.1:3000
```

The runtime script uses an installed `deno`, or the npm Deno launcher through Bun if unavailable. The example relay keeps data in memory and binds to localhost. Refreshing clients reloads from that relay; restarting it clears its documents.

- [API and examples](packages/pulse/README.md)
- [Binary format and connector contract](docs/PROTOCOL.md)
- [Benchmarks, methodology and measured baseline](benchmarks/README.md)
- [CRDT comparison and isolated proxy overhead](benchmarks/CRDT-COMPARISON.md)
- [Rust protocol crate](crates/pulsify-protocol/README.md)
- [Storage architecture notes](DATABASES.md)

## Scope

The v1 core supports object documents, nested objects and arrays, migrations, two-way materialization, subscriptions, reconnection, causal buffering, deduplication and binary decoding through codec with frame-size limits. Strings are atomic values; this is not a character-level text editor API. Tuple/struct constants are immutable through the public view.

The supplied relays are reference implementations with bounded in-memory history. Durable databases, snapshots/compaction, generation restoration and framework-specific adapters are separate integrations. No cloud service is required or included. Applications hosting the relay provide their own authentication, authorization and durable storage.
