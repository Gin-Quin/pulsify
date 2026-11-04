# Hybrid scalar state exchange

The implementation is committed at `3bfc576b2504ee88453ebbbff6ea639fa4836565`.
The final full campaign was measured with a clean worktree (`dirty: false`):
95 cases, five warmup samples, 25 measured samples, seeded participant order,
and the unchanged workloads and GC policy. The first clean implementation
campaign at `b6d020d` is also preserved, including its less favorable small-update
results; the final change avoids state planning for small exact updates.

**Offline parity with json-joy is not achieved.** This change delivers the hybrid
architecture and reduces transfer substantially, while retaining safety checks
and an exact authoritative journal. It must not be presented as a universal
performance win or as being as fast as json-joy on offline fusion.

## Measured results

Times are medians of sample means, in µs/op. Offline bytes are the combined
outgoing deltas from the two peers, excluding network framing.

| Scenario | Pulsify | json-joy | Yjs V2 | Loro WASM | Yjs V1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `edit+encode/10` | 1.638 | 2.697 | 4.848 | 8.392 | 2.261 |
| `delta-roundtrip/10` | 3.449 | 4.534 | 7.728 | 15.900 | 3.951 |
| `delta-roundtrip/1000` | 12.425 | 154.692 | 26.675 | 47.150 | 21.850 |
| `initial-load+materialize/1000` | 367.438 | 659.938 | 547.021 | 1624.771 | 635.104 |
| `offline-merge/100-per-peer` | 146.000 | 90.541 | 78.625 | 239.291 | 62.500 |
| Offline transferred bytes | 176 | 139 | 97 | 1624 | 75 |

Compared with the earlier grouped campaign, offline Pulsify changes from
178.125 µs / 2,246 bytes to 146.000 µs / 176 bytes. These are separate sessions,
not a matched significance test; the CPU reduction is an observed 18.0%, while
the deterministic transfer reduction is 92.2%. The json-joy control changes from
93.916 to 90.541 µs. The new full campaign wins 14/18 primary median comparisons
against json-joy, with an unweighted geometric time ratio of 1.645×. Reads,
small creation+encode, list append and offline fusion remain slower.

- [All 95 cases, p95 and environment](baselines/core-hybrid-20261104.json).
- [Complete generated comparison](CRDT-COMPARISON.md).
- [First clean hybrid campaign, unchanged provenance](baselines/core-hybrid-b6d020d-20261104.json).
- [Earlier grouped campaign](baselines/core-grouped-20261104.json).
- [35 complementary codec/core/connector cases](baselines/core-hybrid-supplementary-20261104.json).

The supplementary campaign uses the same production commit. Its `dirty: true`
records only the generated final comparison and untracked result JSONs present
at that time; the production source was unchanged. It uses the historical
untyped connector workloads and its distinct timing policy, so its numbers
are not interchangeable with the primary typed CRDT comparison.

## Architecture and limits

- The author and authoritative server retain every immutable original operation.
  PostgreSQL, SQLite and FoundationDB schemas and append/query paths are unchanged.
- Negotiated envelope 3 can transmit a homogeneous run of 32+ overwritten typed
  string/float64 registers as its range, shared context and final encoded value.
  The final original row is retained at the receiver; omitted intermediate rows
  are never represented as fabricated journal entries.
- Small updates and arrays, rich text, constants, migrations and structural
  replacements retain exact operations. The current local scalar tail is indexed
  during edits, so its export does not scan all overwritten writes.
- State coverage and physical history have separate vectors. New local writes
  depend on the state vector. Exact exports through a missing history interval
  fail explicitly; `recoverPulseHistory` retrieves and verifies missing rows.
- Connection uploads are always exact. Relays and all database adapters reject
  state-only uploads. V3 relay initial downloads can condense retained grouped
  rows; broadcasts remain exact. Opaque ordinary rows restored from a database
  or mixed creation+edit uploads keep the safe exact fallback.
- Legacy peers remain on v1/v2 and can backfill automatically. Unknown WebSocket
  endpoints keep the legacy handshake; known upgraded endpoints must explicitly
  select `pulsify-v3`. The Rust relay remains an exact v1/v2 implementation.
- State frames require their earlier causal base. Out-of-order state delivery
  fails explicitly and requires ordered delivery or resynchronization. Hidden
  historical values are not audited by receiving a final state delta; retrieve
  the authoritative exact journal for that purpose.

See [wire format and recovery contract](../docs/PROTOCOL.md#optional-state-deltas-envelope-3)
and [public API examples](../packages/pulse/README.md#hybrid-state-exchange).

## Independent review and validation

The independent reviewer reproduced and verified fixes for two bugs: a pending
actor successor with a forked predecessor could be released by state coverage,
and recovery could report success after the source lost its journal. Both now
fail explicitly and atomically. The reviewer also verified the final exact
small-update path, including empty sync replies; no correctness blocker remained.

- `bun run check`: 333 package tests pass, two external DB cases skipped in the
  ordinary run; all 14 CRDT adapter tests pass.
- Twelve focused state tests / 137 assertions cover concurrent convergence,
  forwarding, typed framing and ownership, pending edits/forks, exact hydration,
  duplicate application, source loss and legacy fallback.
- Actual PostgreSQL, SQLite and FoundationDB: 48 tests / 237 assertions, including
  rejecting state-only persistence and retaining all 101 exact source rows.
- Rust: five unit tests and four TS/Rust interoperability tests pass. Unsupported
  state envelopes are rejected rather than acknowledged as operation history.
- Built package: Bun, Node, Deno and Chromium pass shared-entry state decoding and
  backfill. Packed tarball strict NodeNext declarations and Node execution pass.
- Two-tab WebSocket/offline reconnect example and sibling codec fixtures plus
  typed state synchronization pass.

```sh
bun run check
bun run test:storage
bun run test:rust
bun run test:interop
bun run build
BUN_INSTALL_CACHE_DIR=/tmp/pulsify-bun-cache bun run test:package
BUN_INSTALL_CACHE_DIR=/tmp/pulsify-bun-cache DENO_DIR=/tmp/pulsify-deno-cache bun run test:runtimes
bun run test:example
bun run test:codec-local
bun run bench:crdt --output benchmarks/results/hybrid.json --markdown benchmarks/results/hybrid.md
bun run bench --output benchmarks/results/hybrid-supplementary.json
```
