> Historical sequential suite. FoundationDB support and installation tooling have been removed; its recorded results remain archived. The runnable legacy suite now supports PostgreSQL and SQLite.

# Database measurements — 2026-11-04

The complete Docker campaign passed for PostgreSQL 16.15, FoundationDB 7.3.77
and SQLite 3.53.4 with Bun 1.4.4. It contains 81 scenario/profile/backend
measurements, each with 3 warmups and 12 measured samples: 972 measured events
and 243 warmup events. All fresh and incremental document replays, exact-row
checks and frontier checks passed. The 17 real-database contract tests also
passed before measurement.

See the [methodology and storage contract](LEGACY.md), the
[complete table](../baselines/database-20261104/database.md) and the
[raw samples and metadata](../baselines/database-20261104/database.json).

## Large profile: 256 paragraphs and 1,000 edits

Arithmetic medians in milliseconds, including each adapter and its transport:

| Scenario | PostgreSQL | FoundationDB + Python pipe | SQLite |
| --- | ---: | ---: | ---: |
| Write initial full pulse (266,286 operation bytes) | 4.677 | 9.195 | 2.590 |
| Append one patch (62 operation bytes) | 2.161 | 9.666 | 2.208 |
| Read full history (1,001 rows) | 3.047 | 601.496 | 2.337 |
| Load history, apply and materialize the pulse | 9.178 | 713.892 | 6.435 |
| Read missing history (100 rows) | 0.784 | 87.582 | 0.703 |
| Read/apply missing history and materialize | 0.978 | 73.216 | 1.023 |
| Compact closed ranges | 127.686 | 2,086.529 | 18.693 |
| Read full history after compaction | 1.284 | 30.278 | 0.872 |
| Read missing history after compaction | 1.056 | 17.488 | 0.844 |

These are measurements of the benchmark reference adapters, not the public
production adapters or intrinsic engine speed. In particular, FoundationDB
includes one JSON/base64 pipe exchange per key/value primitive. Its uncompressed
history reads perform a separate payload-range request per segment. Compaction
dramatically reduces those requests, so its apparent read improvement includes
a large transport/request-count effect. A native binding and batched range
loading require another measurement campaign before judging FoundationDB for
production use.

## Storage and partial-read tradeoffs

On the large profile all backends stored 787,977 payload bytes before
compaction. They retained about 307,600 afterward: approximately **61% less
payload storage**, with **1,001 segments reduced to 5**. The original creation
segment remains uncompressed; each of the two editing actors has one compressed
historical segment and one uncompressed tail. All 1,001 exact rows survive.
Small byte variations between samples come from random document IDs in the
compressed envelopes; the JSON retains per-sample byte counts.

Before compaction, the vector query loads only 100 missing segments (51,941
payload bytes), rather than the entire 787,977-byte history. After compaction
it loads four matching segments (about 41,230 compressed bytes), decompresses
their historical rows, and returns the same 100 missing rows. The initial
creation segment is never fetched for that delta.

On PostgreSQL and SQLite the large delta median increased slightly after
compaction even though fewer stored bytes were fetched. The decoder must now
expand the older rows in each matching compressed segment before filtering.
Smaller bounded compaction segments are worth testing if small-delta latency
matters more than maximum segment-count reduction. These differences from one
local campaign do not establish statistical significance.

Space figures exclude keys, indexes, metadata, WAL, dead pages and replication.
They do not measure physical file shrinkage. The small vocabulary in the
fixture makes text compressible; results do not describe incompressible media.

## Environment and reproducibility

Measured on 2026-11-04, 18:16:26–18:17:51 Europe/Paris. Host: Apple M4, 10 cores,
32 GiB RAM. OrbStack/Docker 29.8.2 provided 10 virtual CPUs and about 15.66 GiB
RAM; the runner was native Linux ARM64. Its CPU model is reported as `unknown`
inside the VM; the host model above was obtained separately with `sysctl`.

PostgreSQL had `fsync`, `synchronous_commit` and `full_page_writes` on. SQLite
used file-backed WAL and `synchronous=FULL`. FoundationDB used `single ssd`.
All database volumes were fresh, disk-backed and removed after the campaign.
No benchmark containers or volumes remained. The full campaign ran after the
project checks completed, without another benchmark campaign in parallel.

The base commit was `14cedc97860776e17c8e654b5f9d14c258756d46`; the tree was
dirty because this benchmark was new and uncommitted. The raw JSON records the
exact runner image ID and database image IDs. The runner image was
`sha256:098ee572e3483228e219b114bd167fc44116ec9857f895d71caedef2cc84dbbc`.

Backend order was PostgreSQL, FoundationDB, SQLite. Reads were warm and events
were sequential. The complete raw sample arrays retain all outliers; for
example PostgreSQL's large initial-write p95 was 71.548 ms versus a 4.677 ms
median. With 12 samples p95 is the maximum observation, not a stable tail
estimate. Docker filesystem scheduling and host activity can affect these
numbers; do not turn this table into a universal database ranking.

Reproduce into a new directory without overwriting this campaign:

```sh
bun run bench:database --results-dir benchmarks/results/database-reproduction
```
