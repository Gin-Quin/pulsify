# FoundationDB removal — 2026-11-04

FoundationDB production adapters/exports, tests/helpers, Python bridges, native
Rust dependency/binding, link build script, Docker service, SDK download/setup
and installation instructions were removed from the runnable code.

The extracted macOS SDK (`fdbserver`, `fdbcli`, `libfdb_c.dylib`), downloaded
Python source archive, shared-memory marker, FoundationDB Cargo packages/index
entries and task-owned packaged declarations were deleted. The benchmark Cargo
target was cleaned and rebuilt without FoundationDB. `otool -L` confirms the
new executable has no FoundationDB library dependency.

The FoundationDB 7.3.77 Docker image, four FoundationDB-linked runner images,
and the related build cache including the old legacy base image ancestry were
removed by exact ID. Other projects' images, containers and volumes were not
pruned. Docker's documented reclaim-space helper ran after a measured worker
completed, while the orchestrator waited, to return free blocks to macOS.

No FoundationDB package receipt or launch daemon was registered. Checked system
installation paths, the former SDK location and Python module discovery are
empty. No matching FoundationDB binaries or SDK were found under the user's
native temporary directory. The explicit paths and removed artifacts are in
[the machine-readable audit](foundationdb-cleanup.json).

The removed filesystem artifacts totaled about 307 MB. Cleaning the task's
Cargo target removed 788.7 MiB of compiled artifacts; a smaller FoundationDB-free
target was subsequently rebuilt. Docker reports virtual/shared image sizes,
so those sizes are not added into a claimed physical-space total. The user's
later release of a memory-hogging application also freed swap space and is
recorded separately in [host interventions](INTERVENTIONS.md).

[Historical results](../../database/archive/FOUNDATIONDB-RESULTS.md), raw request
records, failure diagnostics and methodology remain as text/compressed data.
These are archives, not an installed database or runnable installation path.
