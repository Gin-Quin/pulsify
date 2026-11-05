> Historical sequential suite. FoundationDB support and installation tooling have been removed; its recorded results remain archived. The runnable legacy suite now supports PostgreSQL and SQLite.

# Pulsify database benchmark

Real Pulsify documents and exact operation history against PostgreSQL,
FoundationDB and SQLite, all inside Docker. The suite measures durable writes,
vector-based reads and lossless compaction, and verifies document replay.

The [recorded full campaign](LEGACY-RESULTS.md) includes results for all three profiles
and databases, with raw samples and interpretation limits.

## Run

Requirements: Docker Engine with Compose v2+, and Bun on the host. The first
run downloads pinned images/dependencies. ARM64 and AMD64 use native images.

From the repository root:

```sh
# All databases; small profile; 1 warmup + 3 measured samples.
bun run bench:database:legacy --quick

# All databases/profiles; 3 warmups + 12 measured samples.
bun run bench:database:legacy

# A custom campaign.
bun run bench:database:legacy --databases postgres,foundationdb,sqlite \
  --profiles medium,large --warmup 5 --samples 25 \
  --results-dir benchmarks/results/database-custom

# Local contract tests (file-backed SQLite).
bun run test:database

# Contract tests for all three real databases in Docker, without benchmarking.
bun run test:database:docker
```

Each Docker invocation builds the runner, creates an isolated Compose project,
initializes fresh databases, runs the contract tests, then measures. It writes
`database.json` and `database.md` to `benchmarks/results/` by default. Choose a
new `--results-dir` to retain another campaign. Failures exit nonzero without
overwriting prior reports with partial timing results.

Containers, network and database volumes are removed on success, failure,
SIGINT or SIGTERM. Reports and the built image remain. No host ports are
exposed. PostgreSQL and FoundationDB run in separate services. SQLite is an
embedded **file-backed** database inside the runner, not a TCP service or an
in-memory substitute; its files disappear with that container.

## Workloads and timing boundaries

The typed schema contains title, revision, editable nested metadata and a list
of editable paragraphs. Actor 70001 creates the document; actors 70002/70003
alternate edits to revision, title and paragraph text, synchronizing between
edits. These are actual Pulsify binary operations with causal dependencies.
History export is explicit: hybrid state summaries are never stored as history.

| Profile | Paragraphs | Initial characters per paragraph | Edits |
| --- | ---: | ---: | ---: |
| small | 8 | 256 | 20 |
| medium | 64 | 512 | 100 |
| large | 256 | 1024 | 1000 |

Content uses a deterministic PRNG (seed 20261104) and a small English vocabulary.
It is compressible manuscript-like text, not a binary-media or entropy stress
test. The remote vector is captured after 90% of edits and includes three
actors. Samples use fresh document IDs and identical content/actor schedules.

| Scenario | Timed work |
| --- | --- |
| `write_full` | Encode initial history into segments, validate, durably store history and frontier |
| `write_patch` | Encode and durably append the final edit, updating the frontier |
| `read_full` | Query all history segments, decode/decompress and return exact rows |
| `load_full` | Create a receiver, read/apply full history and materialize its detached snapshot |
| `read_delta` | Query segments after the remote vector and return missing rows |
| `sync_delta` | Read/apply missing rows to a prepared partial receiver and materialize a snapshot |
| `compact` | Read closed history, encode/compress, conditionally replace source segments |
| `read_full_compacted` | Read/decode full history after compaction |
| `read_delta_compacted` | Query/decode missing history after compaction |

Source creation, mutations/export, setting up existing history and the partial
receiver, assertions, destruction and process/database/container startup are
outside timers. Reads include SHA-256 integrity verification. Materialization
is included only in `load_full` and `sync_delta`. No application network or
connector acknowledgment is simulated. One event is timed per sample, at
concurrency 1.

Scenarios always run in the above lifecycle; backends follow `--databases`
order. Warmups use the same lifecycle. Documents accumulate until the campaign
ends. Reads are warm local reads, not cold-cache or steady-state size tests.
Reverse backend order in another campaign to inspect order effects.

JSON retains raw warmup/measured timings, arithmetic median, nearest-rank p95,
bytes fetched, returned rows, segments, compression savings, runtime, CPU,
Docker resources, image IDs, commit and dirty-tree status. With 12 samples p95
is the maximum; increase samples for tail analysis. There is no performance
pass/fail threshold or universal ranking.

## Storage policy and compaction

These are **benchmark-specific reference adapters**, separate from the public
`PostgresPatchStore`, `SqlitePatchStore` and `FoundationDBPatchStore`, which
store immutable individual rows and have no compaction API. This suite adds a
shared segment representation to test the same compaction algorithm on each
backend. Its results are not production-adapter regression baselines.

The layout follows [DATABASES.md](../../DATABASES.md): `(docId,sid,start)`
identity, exclusive ends, binary payloads, indexed vector reads, transactional
frontiers and conditional compaction. SQL databases use `bench_segments` and
`bench_clocks`; the latter holds each document's small vector as JSON text.
FoundationDB uses ordered start/end indexes, a vector key and chunked payloads.
64 KiB chunks stay below its value limit; an 8 MB write budget leaves margin
below the transaction limit ([official limits](https://apple.github.io/foundationdb/known-limitations.html)).

Each original patch is one raw segment containing a normal Pulsify frame.
Compaction groups a closed range **per actor**, preserving its newest segment
as the write tail, and deflates the combined frame at level 6. Several patches
become one stored compressed segment. Every original row, intermediate edit,
operation ID and dependency survives. The two editing actors keep separate
segments for indexed access; the initial snapshot remains a separate segment.

Compression runs outside the replacement transaction. Inside it, the store
checks all source identities, boundaries, dependencies, codecs and SHA-256
fingerprints before deleting anything. A competing compaction invalidates an
old plan; a later append survives. PostgreSQL uses a document advisory lock,
SQLite `BEGIN IMMEDIATE`, and FoundationDB conflict-tracked reads with the
official binding's retry/backoff.

Queries select `segment.end > remoteClock` per actor, including a segment
containing the remote boundary; omitted actors use clock zero. Only matching
payloads are fetched. A compressed segment must be decoded in full before
known rows can be filtered. Compaction can therefore increase bytes fetched
for a small delta. Reports show bytes/segments before and after; `payloadBytes`
means stored bytes fetched, not just useful bytes returned to a peer.

This benchmark accepts causally contiguous appends and rejects gaps, forks and
overlaps atomically. Exact uncompressed duplicates are idempotent. Buffering
dangling arrivals and partially overlapping retries after compaction are outside
its contract; production storage has a separate dangling-repair conformance
suite. Compaction packs one closed range per actor within Pulsify frame limits;
it is not unbounded production history maintenance.

## Durability and interpretation

PostgreSQL uses logged tables and ordinary synchronous commits; its report
captures `fsync`, `synchronous_commit` and `full_page_writes`. SQLite uses WAL
and `synchronous=FULL` on the container filesystem. FoundationDB uses a real
disk-backed `single ssd` database, with no redundancy. No tmpfs or disabled
durability settings are used.

PostgreSQL uses Bun SQL over Compose TCP; SQLite uses in-process `bun:sqlite`.
FoundationDB uses the pinned official Python binding over a persistent local
JSON/base64 pipe **per key/value primitive**, then Compose TCP. Its bridge and
serialization costs are timed, while startup is excluded. These numbers cannot
rank intrinsic engine throughput. A native binding can replace the bridge
behind the same repository contract. Single-node results do not establish
distributed scalability.

Space savings are encoded payload lengths, excluding keys, indexes, metadata,
WAL, dead pages and replication. Deleted segments do not imply immediate file
shrinkage. Physical disk reclamation, concurrent-client throughput, crash
recovery, large vectors and production-scale histories are not measured.

## Architecture and adding a backend

| File | Responsibility |
| --- | --- |
| `fixtures.ts` | Real typed pulses, deterministic edits, expected state |
| `segments.ts` | Lossless binary packing, compression, integrity |
| `types.ts` | Transactional repository contract |
| `store.ts` | Causal append, filtering, safe compaction policy |
| `adapters/` | Database queries, ordered keys and binding |
| `runner.ts` | Scenario lifecycle, timings and correctness checks |
| `report.ts` | Statistics and report model |
| `store.test.ts` | Shared conformance suite |
| `docker.ts`, `compose.yaml`, `Dockerfile` | Isolated execution and cleanup |

Implement `SegmentRepository`/`SegmentTransaction`. Transactions must roll back
on exceptions and protect all reads used to decide writes. `read(vector)` must
return matching segments ordered by actor/start. Register the adapter factory
in `runner.ts`, add it to `store.test.ts`, and supply its Docker service/client.
Workloads and timing code should remain backend-independent.

The runner can also be invoked directly for local development:

```sh
bun benchmarks/database/runner.ts --databases sqlite --quick \
  --output /tmp/database.json --markdown /tmp/database.md
```

The Docker command uses `--results-dir` to map both reports to the host. Its
contract tests always cover all three databases even when timing is filtered.
