# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|sqlite|mixed|spread|burst|128|2441.3|16.735|202.796|284.633|406.853|0|37|11/89|
|bare-metal|sqlite|mixed|spread|saturation|128|2494.5|15.452|201.353|295.479|295.479|0|48|14/86|
|bare-metal|sqlite|mixed|hot|burst|128|1566.4|30.917|320.978|602.916|636.821|0|411|38/62|
|bare-metal|sqlite|mixed|hot|saturation|128|1827.8|26.157|265.000|512.187|512.187|0|403|36/64|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|sqlite|spread|burst|128|compact|100|244.1|0.705|263.981|352.534|385.191|0|37|11/89|
|bare-metal|sqlite|spread|burst|128|read_delta|250|610.3|1.379|61.970|65.355|371.631|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|244.1|2.847|56.319|63.745|365.554|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|244.1|42.210|193.143|234.174|400.525|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|1098.6|50.627|230.725|306.651|408.321|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|249.4|48.613|316.473|380.295|380.295|0|48|14/86|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|623.6|1.263|70.364|89.993|89.993|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|249.4|5.380|97.863|106.432|106.432|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|249.4|26.800|230.669|267.443|267.443|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|1122.5|40.551|195.249|263.358|263.358|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|156.6|205.317|624.803|636.322|638.078|0|411|38/62|
|bare-metal|sqlite|hot|burst|128|read_delta|250|391.6|2.946|147.856|160.062|591.219|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|156.6|4.483|173.509|182.756|577.089|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|156.6|42.843|278.059|323.721|613.545|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|704.9|49.819|279.895|395.431|626.790|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|182.8|190.095|539.112|542.020|542.020|0|403|36/64|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|457.0|2.282|104.030|115.339|115.339|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|182.8|2.868|135.603|139.795|139.795|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|182.8|43.488|248.317|288.377|288.377|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|822.5|36.940|247.209|327.319|327.319|0|0|0/0|

4 completed cells, 4000 requests, 0 errors, 8 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
