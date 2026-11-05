# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|128|1280.0|32.993|548.054|607.047|775.949|0|40|10/90|
|bare-metal|postgres|mixed|spread|saturation|128|1482.3|23.676|442.925|508.015|508.015|0|43|9/91|
|bare-metal|postgres|mixed|hot|burst|128|1289.0|95.538|291.838|346.112|772.330|0|125|5/95|
|bare-metal|postgres|mixed|hot|saturation|128|1138.5|104.335|295.392|345.869|345.869|0|124|5/95|
|bare-metal|sqlite|mixed|spread|burst|128|1073.9|0.734|508.764|808.706|813.664|0|42|45/55|
|bare-metal|sqlite|mixed|spread|saturation|128|892.8|0.683|609.023|821.651|821.651|0|35|44/56|
|bare-metal|sqlite|mixed|hot|burst|128|968.0|1.338|454.546|705.467|742.299|0|73|44/56|
|bare-metal|sqlite|mixed|hot|saturation|128|891.4|1.291|483.722|814.932|814.932|0|73|47/53|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|128|compact|100|128.0|5.858|611.544|617.899|761.532|0|40|10/90|
|bare-metal|postgres|spread|burst|128|read_delta|250|320.0|2.867|24.815|25.797|739.326|0|0|0/0|
|bare-metal|postgres|spread|burst|128|read_full|100|128.0|7.899|66.857|69.751|732.536|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_full|100|128.0|6.208|55.290|64.768|735.707|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_patch|450|576.0|58.626|546.167|557.761|778.699|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|compact|100|148.2|20.846|522.914|562.481|562.481|0|43|9/91|
|bare-metal|postgres|spread|saturation|128|read_delta|250|370.6|2.537|25.010|27.802|27.802|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|read_full|100|148.2|8.223|65.814|68.717|68.717|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_full|100|148.2|5.461|53.581|58.411|58.411|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_patch|450|667.0|66.558|442.626|461.009|461.009|0|0|0/0|
|bare-metal|postgres|hot|burst|128|compact|100|128.9|259.082|354.380|374.968|775.551|0|125|5/95|
|bare-metal|postgres|hot|burst|128|read_delta|250|322.3|1.401|22.159|25.887|612.119|0|0|0/0|
|bare-metal|postgres|hot|burst|128|read_full|100|128.9|4.371|55.654|59.764|595.965|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_full|100|128.9|2.681|43.787|56.430|595.394|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_patch|450|580.1|107.711|289.554|296.236|701.570|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|compact|100|113.9|295.392|357.636|368.070|368.070|0|124|5/95|
|bare-metal|postgres|hot|saturation|128|read_delta|250|284.6|1.691|22.665|25.694|25.694|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|read_full|100|113.9|3.901|57.809|61.317|61.317|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_full|100|113.9|2.998|39.354|43.018|43.018|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_patch|450|512.3|136.601|285.716|288.723|288.723|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|compact|100|107.4|2.600|692.848|812.647|827.881|0|42|45/55|
|bare-metal|sqlite|spread|burst|128|read_delta|250|268.5|0.672|69.680|83.247|400.186|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|107.4|1.413|93.035|96.864|397.525|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|107.4|0.947|505.874|813.300|813.664|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|483.3|0.157|609.809|823.542|875.289|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|89.3|0.731|762.310|981.982|981.982|0|35|44/56|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|223.2|0.656|65.833|81.263|81.263|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|89.3|1.381|78.216|81.988|81.988|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|89.3|1.095|600.993|821.651|821.651|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|401.8|0.162|696.971|906.645|906.645|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|96.8|12.544|519.990|645.698|645.990|0|73|44/56|
|bare-metal|sqlite|hot|burst|128|read_delta|250|242.0|1.392|134.445|143.444|405.899|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|96.8|1.956|157.593|164.273|398.704|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|96.8|1.079|487.835|817.858|818.202|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|435.6|0.145|497.565|812.386|812.549|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|89.1|2.440|514.473|782.609|782.609|0|73|47/53|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|222.9|1.297|90.381|110.060|110.060|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|89.1|1.865|123.148|132.196|132.196|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|89.1|0.988|705.649|1107.073|1107.073|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|401.1|0.143|587.576|904.099|904.099|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
