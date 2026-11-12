# AlloyDB Omni, OrioleDB and pgrust removal

All recorded results are retained: **574,000 checkpointed requests**, including
the incomplete/OOM matrices, 13 completed fresh probe cells and two further
isolated OOM failures. The
[scores and diagnostics](SUMMARY.md), raw gzip reports, replay proofs, contexts,
container states and logs remain available.

Before removal, the result/provenance artifacts were checked (including gzip
integrity), then indexed in [RESULTS-MANIFEST.json](RESULTS-MANIFEST.json) with
size and SHA-256. Every indexed artifact was verified unchanged after cleanup.
Image identities, versions and digests are saved in
[provenance/removed-server-images.json](provenance/removed-server-images.json).

Removed installations:

- `google/alloydbomni:17.10.0`, image `166ff091cc25…`;
- `orioledb/orioledb:latest-pg17`, image `970b635d3880…`;
- `malisper/pgrust:v0.4-beta`, image `4c9cd6f3769f…`.

All three image IDs are absent. No target containers, volumes, running
processes, package receipts or matching build-cache records remain. The
existing generic Google Cloud SDK's
`surface/alloydb` CLI command definitions remain: they are not an installed
AlloyDB server, and removing them would damage a shared SDK.

Observed available disk space increased by approximately **3.85 GB (3.59 GiB)**
during cleanup. This is an observed filesystem difference, not a sum of Docker
image sizes, whose layers can be shared.

Benchmark source, optional engine configurations and historical reports remain
for reproducibility. PostgreSQL, SQLite, the generic Rust benchmark client and
unrelated projects' data/services were retained. Choosing these engines in a
future Docker benchmark explicitly downloads their images again.

[Machine-readable removal audit](DATABASE-REMOVAL.json).
