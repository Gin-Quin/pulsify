# Host intervention

On 2026-11-04 the user closed an application that exhausted host RAM. Swap had exceeded 33 GiB; available memory then returned to 70%. The pre-intervention matrix is retained under `failures/memory-pressure/` and excluded from comparisons. Both retained medium and large matrices start after this intervention. Per-backend host memory, swap and free-disk snapshots are recorded in their contexts. A nonzero residual swap allocation alone does not imply ongoing memory pressure.

A later adapter review found a missing non-unique point-lookup index for pgrust columnar after its unsupported primary key was removed. That matrix is excluded under `failures/columnar-index-missing/`. The retained matrices add the point index and capture the actual index definitions.

At 128 native columnar clients, query-memory amplification caused SQL timeouts (584 errors in the first spread-compaction cell). The Mac rebooted at 21:49:46 Europe/Paris; reboot cause is not established. Native checkpoints are retained with an incomplete status. The remaining Docker phase runs separately with a uniform 4 GiB/no-swap per-container limit to contain failures. Its context and configuration are recorded separately from the native phase and uncapped medium run. Missing native vector/mixed groups are tested separately on a fresh instance and not merged as an uninterrupted matrix.
