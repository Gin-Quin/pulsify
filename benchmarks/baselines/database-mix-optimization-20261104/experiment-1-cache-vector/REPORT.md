# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|128|1827.2|21.862|353.303|422.317|545.151|0|41|13/87|
|bare-metal|postgres|mixed|spread|saturation|128|2482.2|25.431|221.955|284.630|284.630|0|41|9/91|
|bare-metal|postgres|mixed|hot|burst|128|2105.8|56.571|160.969|213.587|472.155|0|124|5/95|
|bare-metal|postgres|mixed|hot|saturation|128|2005.9|61.514|173.821|232.395|232.395|0|132|5/95|
|bare-metal|sqlite|mixed|spread|burst|128|1090.2|0.729|469.571|709.025|711.414|0|40|39/61|
|bare-metal|sqlite|mixed|spread|saturation|128|915.9|0.735|463.305|675.058|675.058|0|37|41/59|
|bare-metal|sqlite|mixed|hot|burst|128|1018.7|1.409|386.325|671.966|672.209|0|91|43/57|
|bare-metal|sqlite|mixed|hot|saturation|128|1018.6|1.381|431.658|771.938|771.938|0|86|44/56|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|128|compact|100|182.7|11.257|425.855|434.336|533.203|0|41|13/87|
|bare-metal|postgres|spread|burst|128|read_delta|250|456.8|3.317|25.390|32.031|524.044|0|0|0/0|
|bare-metal|postgres|spread|burst|128|read_full|100|182.7|10.589|68.681|72.721|520.566|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_full|100|182.7|6.046|45.324|47.006|520.188|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_patch|450|822.2|48.602|351.191|365.305|546.277|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|compact|100|248.2|3.657|292.274|298.008|298.008|0|41|9/91|
|bare-metal|postgres|spread|saturation|128|read_delta|250|620.6|3.417|26.193|30.662|30.662|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|read_full|100|248.2|8.920|65.015|69.610|69.610|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_full|100|248.2|6.309|41.232|47.229|47.229|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_patch|450|1117.0|43.307|214.776|232.161|232.161|0|0|0/0|
|bare-metal|postgres|hot|burst|128|compact|100|210.6|152.147|218.443|223.527|474.874|0|124|5/95|
|bare-metal|postgres|hot|burst|128|read_delta|250|526.5|1.758|23.226|26.362|375.733|0|0|0/0|
|bare-metal|postgres|hot|burst|128|read_full|100|210.6|3.898|60.692|64.640|365.816|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_full|100|210.6|2.572|35.388|38.368|364.577|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_patch|450|947.6|70.690|158.521|168.366|444.818|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|compact|100|200.6|153.822|236.260|256.447|256.447|0|132|5/95|
|bare-metal|postgres|hot|saturation|128|read_delta|250|501.5|1.679|24.312|25.841|25.841|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|read_full|100|200.6|4.118|61.261|63.833|63.833|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_full|100|200.6|2.640|35.975|38.094|38.094|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_patch|450|902.6|68.568|172.117|186.692|186.692|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|compact|100|109.0|0.819|645.176|751.479|751.775|0|40|39/61|
|bare-metal|sqlite|spread|burst|128|read_delta|250|272.6|0.664|74.675|95.432|400.910|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|109.0|1.328|73.944|90.697|397.822|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|109.0|0.990|506.563|713.711|714.049|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|490.6|0.172|497.613|711.217|711.414|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|91.6|1.319|434.576|528.689|528.689|0|37|41/59|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|229.0|0.651|68.218|78.468|78.468|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|91.6|1.309|67.668|78.039|78.039|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|91.6|1.258|463.565|779.034|779.034|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|412.1|0.180|560.687|779.400|779.400|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|101.9|10.788|500.915|603.497|603.672|0|91|43/57|
|bare-metal|sqlite|hot|burst|128|read_delta|250|254.7|1.396|113.447|122.201|387.173|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|101.9|2.200|150.386|158.986|379.938|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|101.9|1.155|566.873|774.348|774.627|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|458.4|0.141|463.845|773.134|773.236|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|101.9|20.865|385.478|431.658|431.658|0|86|44/56|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|254.7|1.338|88.398|118.720|118.720|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|101.9|2.258|119.408|125.340|125.340|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|101.9|1.630|462.105|568.982|568.982|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|458.4|0.141|569.351|871.635|871.635|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
