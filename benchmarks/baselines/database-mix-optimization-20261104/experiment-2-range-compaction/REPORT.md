# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|128|3720.0|21.828|106.156|149.280|266.728|0|39|9/91|
|bare-metal|postgres|mixed|spread|saturation|128|3864.5|21.965|98.176|138.785|138.785|0|40|12/88|
|bare-metal|postgres|mixed|hot|burst|128|2526.4|52.044|116.891|153.716|392.905|0|125|5/95|
|bare-metal|postgres|mixed|hot|saturation|128|2460.8|56.531|121.692|156.569|156.569|0|131|5/95|
|bare-metal|sqlite|mixed|spread|burst|128|1140.7|0.725|360.648|567.780|578.607|0|42|36/64|
|bare-metal|sqlite|mixed|spread|saturation|128|1120.3|0.726|361.424|575.898|575.898|0|35|37/63|
|bare-metal|sqlite|mixed|hot|burst|128|841.2|1.346|460.214|871.536|873.869|0|81|44/56|
|bare-metal|sqlite|mixed|hot|saturation|128|714.8|1.342|365.361|1087.797|1087.797|0|83|44/56|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|128|compact|100|372.0|8.839|156.431|167.268|246.976|0|39|9/91|
|bare-metal|postgres|spread|burst|128|read_delta|250|930.0|3.839|24.679|31.505|250.251|0|0|0/0|
|bare-metal|postgres|spread|burst|128|read_full|100|372.0|13.232|65.737|70.362|240.027|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_full|100|372.0|7.165|38.611|40.710|244.461|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_patch|450|1674.0|41.186|103.878|119.531|267.988|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|compact|100|386.5|4.368|148.776|181.042|181.042|0|40|12/88|
|bare-metal|postgres|spread|saturation|128|read_delta|250|966.1|3.567|22.654|31.963|31.963|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|read_full|100|386.5|12.091|61.658|64.479|64.479|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_full|100|386.5|6.093|32.594|38.211|38.211|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_patch|450|1739.0|40.320|96.925|109.913|109.913|0|0|0/0|
|bare-metal|postgres|hot|burst|128|compact|100|252.6|100.129|157.343|161.660|395.628|0|125|5/95|
|bare-metal|postgres|hot|burst|128|read_delta|250|631.6|1.828|21.085|24.673|321.203|0|0|0/0|
|bare-metal|postgres|hot|burst|128|read_full|100|252.6|4.670|55.782|59.674|312.176|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_full|100|252.6|2.597|35.133|37.991|310.630|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_patch|450|1136.9|65.882|110.570|118.819|362.656|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|compact|100|246.1|105.548|158.369|161.830|161.830|0|131|5/95|
|bare-metal|postgres|hot|saturation|128|read_delta|250|615.2|1.917|21.083|24.279|24.279|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|read_full|100|246.1|3.855|56.003|60.077|60.077|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_full|100|246.1|2.674|38.080|40.329|40.329|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_patch|450|1107.4|71.130|113.093|122.205|122.205|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|compact|100|114.1|1.600|431.638|544.134|556.435|0|42|36/64|
|bare-metal|sqlite|spread|burst|128|read_delta|250|285.2|0.660|68.417|83.417|312.254|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|114.1|1.459|79.437|82.197|307.814|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|114.1|1.059|364.390|469.057|574.655|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|513.3|0.147|374.279|664.791|670.671|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|112.0|0.491|438.433|535.317|535.317|0|35|37/63|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|280.1|0.651|65.138|78.265|78.265|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|112.0|1.337|74.202|82.898|82.898|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|112.0|0.857|469.609|683.822|683.822|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|504.2|0.165|370.601|581.621|581.621|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|84.1|11.094|496.279|511.150|511.655|0|81|44/56|
|bare-metal|sqlite|hot|burst|128|read_delta|250|210.3|1.334|109.476|117.374|374.592|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|84.1|1.984|139.125|145.358|369.791|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|84.1|0.900|566.478|877.795|878.212|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|378.6|0.153|469.211|980.140|981.047|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|71.5|23.384|380.148|570.020|570.020|0|83|44/56|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|178.7|1.463|86.208|96.346|96.346|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|71.5|1.994|118.852|125.371|125.371|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|71.5|1.061|779.424|1081.316|1081.316|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|321.7|0.120|567.891|1190.534|1190.534|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
