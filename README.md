# Pulsify

Typed collaborative documents for TypeScript, with a versioned binary protocol usable from other languages.

The core implements its own CRDT engine: inline LWW registers for object fields
and an RGA for arrays and rich text. It has no runtime dependency on `json-joy`
or Yjs. `@gin-quin/codec` **2.1.0** compiles the shared application schema and
binary codecs; Pulsify also compiles field slots, value checks and copies.
Normal-looking object and array proxies address stable collaborative nodes.

Connectors exchange binary frames and version vectors. PostgreSQL, SQLite and
FoundationDB stores accept encoded patches and query missing actor ranges
without loading the document. A dependency-free Rust crate implements the
envelope and opaque causal journal independently.

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
bun scripts/test-storage.ts  # Actual PostgreSQL, SQLite and FoundationDB integration checks
bun run bench                 # Reproducible performance report
bun run bench:crdt            # Pulsify / native json-joy / Yjs / Loro, including proxy overhead
bun run dev                   # Two-tab WebSocket example at http://127.0.0.1:3000
```

The runtime script uses an installed `deno`, or the npm Deno launcher through Bun if unavailable. The example relay keeps data in memory and binds to localhost. Refreshing clients reloads from that relay; restarting it clears its documents.

- [API and examples](packages/pulse/README.md)
- [Binary format and connector contract](docs/PROTOCOL.md)
- [Benchmarks, methodology and measured baseline](benchmarks/README.md)
- [CRDT comparison and isolated proxy overhead](benchmarks/CRDT-COMPARISON.md)
- [Native core results and remaining performance limits](benchmarks/GROUPED-TRANSPORT.md)
- [Rust protocol crate](crates/pulsify-protocol/README.md)
- [PostgreSQL, SQLite and FoundationDB storage](docs/STORAGE.md)
- [Storage requirements and design notes](DATABASES.md)

## Scope

The native core supports nested objects, dense arrays, primitives, binary
values, Unicode rich text, immutable schema fields, migrations, two-way
materialization, subscriptions and offline synchronization. Plain strings are
atomic registers; rich text is selected explicitly with a schema annotation or
`richText()` initializer. Its positions count Unicode code points and its
formatting is available through `toDelta()`.

The same codec schema describes stored values and typed public fields. Numeric
field slots and specialized codecs avoid repeating schema information in each
mutation. Definitions retain previous layouts for versioned migrations.
Constant fields are initialized once and reject later replacement or nested
edits. Local history is encoded lazily when requested for export.

Envelope version 1 and the optional negotiated grouped envelope 2 carry operation payload version 2. Every transaction
uses one contiguous actor sequence number; its separate Lamport timestamp
orders concurrent register writes. The protocol keeps row identities stable
and buffers gaps and missing dependencies. Operation format 1 from the previous
json-joy implementation is incompatible with this payload format.

The supplied relays keep bounded in-memory history. Durable adapters are
available separately through `@pulsify/core/storage`; applications connect them
to their relay and acknowledge writes after committing storage. Snapshots,
history compaction, restored generations and framework adapters are not
negotiated by this protocol. The host application supplies authentication and
authorization. The benchmark reports describe measured workloads and retained
history differences; they do not claim a universal performance ranking.
