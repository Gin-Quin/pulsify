# Excluded trials and controller diagnostics

These files are not included in the complete 576-cell/576,000-request corpus.
Completed cohorts are in `../medium` and `../large`; their request errors are
retained there, rather than removed as outliers.

- `partial-postgres-low-disk.json.gz` and `medium-low-disk.log`: an early
  medium run stopped when the host disk filled. The inspected server log had
  `PANIC: could not create file "pg_logical/replorigin_checkpoint.tmp": No space left on device`
  during its checkpoint. The ephemeral server log was removed with that run;
  the client log and completed request cells are retained here.
- `postgres-before-space-release.json.gz`: a complete PostgreSQL trial under
  the original low-space conditions, superseded by a fresh complete run after
  the user freed disk space. It was not repeated to select favorable timings.
- `fdb-before-space-release.json.gz` and `foundationdb-low-space.log`:
  FoundationDB stalled its write admission. The trace excerpt records
  `TPSLimit="0"` and zero available storage/log space. Its disk protection was
  not disabled to force the benchmark to continue.
- `large-fdb-1gib-partial.json.gz` and `large-fdb-1gib.log`: the 128-client large
  workload completed its first full-write cell, then the FoundationDB process
  reported `ERROR: Out of memory`; subsequent transactions timed out. The
  configured 1 GiB resident limit was too small for this trial. Complete large
  FoundationDB matrices were subsequently collected with a 4 GiB limit.
- `medium-controller-failure.json`: the first restored-space controller
  stopped after FoundationDB had completed all its cells with three recorded
  compaction retry-budget errors. The complete PostgreSQL/FoundationDB data
  from that invocation were retained in `../medium`, verified through Pulsify,
  and joined with the later SQLite and Docker invocations. The controller now
  finishes remaining independent backends before returning a failing status.
- `large-controller-failure.json` and the `*-failure-*.log` files retain the
  corresponding controller/server diagnostics. The original large native
  PostgreSQL matrix completed before the FoundationDB memory-limit failure;
  its complete results remain in `../large`.

A server-crash trial is not evidence of successful crash recovery or of
integrity for unobserved/incomplete requests. Integrity claims in the main
results apply to completed, explicitly verified cells only.
