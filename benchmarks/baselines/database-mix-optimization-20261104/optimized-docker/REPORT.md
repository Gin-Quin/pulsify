# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|docker|postgres|mixed|spread|burst|128|2783.3|24.917|132.454|186.474|346.658|0|39|8/92|
|docker|postgres|mixed|spread|saturation|128|2923.5|30.659|117.795|165.176|165.176|0|44|10/90|
|docker|postgres|mixed|hot|burst|128|875.1|144.308|262.303|651.675|1138.981|0|203|6/94|
|docker|postgres|mixed|hot|saturation|128|876.0|131.034|274.233|520.546|520.546|0|132|5/95|
|docker|sqlite|mixed|spread|burst|128|919.8|10.885|589.918|899.689|1071.960|0|42|18/82|
|docker|sqlite|mixed|spread|saturation|128|899.4|7.237|593.682|949.905|949.905|0|27|16/84|
|docker|sqlite|mixed|hot|burst|128|888.9|28.335|603.190|1011.074|1110.664|0|169|40/60|
|docker|sqlite|mixed|hot|saturation|128|778.9|34.063|660.940|1073.410|1073.410|0|155|44/56|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|docker|postgres|spread|burst|128|compact|100|278.3|6.571|201.566|228.465|291.512|0|39|8/92|
|docker|postgres|spread|burst|128|read_delta|250|695.8|2.373|29.128|57.966|295.939|0|0|0/0|
|docker|postgres|spread|burst|128|read_full|100|278.3|6.947|149.257|161.129|292.533|0|0|0/0|
|docker|postgres|spread|burst|128|write_full|100|278.3|8.459|34.028|54.647|295.235|0|0|0/0|
|docker|postgres|spread|burst|128|write_patch|450|1252.5|52.301|127.930|147.224|354.249|0|0|0/0|
|docker|postgres|spread|saturation|128|compact|100|292.4|47.308|173.493|192.393|192.393|0|44|10/90|
|docker|postgres|spread|saturation|128|read_delta|250|730.9|2.527|27.094|57.461|57.461|0|0|0/0|
|docker|postgres|spread|saturation|128|read_full|100|292.4|6.847|76.648|93.034|93.034|0|0|0/0|
|docker|postgres|spread|saturation|128|write_full|100|292.4|9.181|82.029|90.079|90.079|0|0|0/0|
|docker|postgres|spread|saturation|128|write_patch|450|1315.6|56.660|116.296|144.199|144.199|0|0|0/0|
|docker|postgres|hot|burst|128|compact|100|87.5|262.303|675.581|909.331|1142.688|0|203|6/94|
|docker|postgres|hot|burst|128|read_delta|250|218.8|1.464|30.542|42.426|879.258|0|0|0/0|
|docker|postgres|hot|burst|128|read_full|100|87.5|2.716|80.185|95.924|829.185|0|0|0/0|
|docker|postgres|hot|burst|128|write_full|100|87.5|4.456|58.961|66.941|826.550|0|0|0/0|
|docker|postgres|hot|burst|128|write_patch|450|393.8|216.269|250.211|253.400|1062.019|0|0|0/0|
|docker|postgres|hot|saturation|128|compact|100|87.6|240.780|551.765|580.370|580.370|0|132|5/95|
|docker|postgres|hot|saturation|128|read_delta|250|219.0|1.493|37.230|55.726|55.726|0|0|0/0|
|docker|postgres|hot|saturation|128|read_full|100|87.6|3.644|78.596|85.844|85.844|0|0|0/0|
|docker|postgres|hot|saturation|128|write_full|100|87.6|4.508|68.011|89.842|89.842|0|0|0/0|
|docker|postgres|hot|saturation|128|write_patch|450|394.2|233.461|271.472|275.219|275.219|0|0|0/0|
|docker|sqlite|spread|burst|128|compact|100|92.0|5.510|605.710|977.318|1002.558|0|42|18/82|
|docker|sqlite|spread|burst|128|read_delta|250|230.0|0.688|54.694|71.058|895.761|0|0|0/0|
|docker|sqlite|spread|burst|128|read_full|100|92.0|1.779|65.538|79.740|862.145|0|0|0/0|
|docker|sqlite|spread|burst|128|write_full|100|92.0|112.354|749.110|893.618|1064.532|0|0|0/0|
|docker|sqlite|spread|burst|128|write_patch|450|413.9|114.359|649.493|963.971|1080.761|0|0|0/0|
|docker|sqlite|spread|saturation|128|compact|100|89.9|0.230|917.201|1013.416|1013.416|0|27|16/84|
|docker|sqlite|spread|saturation|128|read_delta|250|224.8|0.712|39.173|63.301|63.301|0|0|0/0|
|docker|sqlite|spread|saturation|128|read_full|100|89.9|1.676|59.799|68.193|68.193|0|0|0/0|
|docker|sqlite|spread|saturation|128|write_full|100|89.9|156.156|634.567|920.647|920.647|0|0|0/0|
|docker|sqlite|spread|saturation|128|write_patch|450|404.7|123.244|722.722|1012.223|1012.223|0|0|0/0|
|docker|sqlite|hot|burst|128|compact|100|88.9|258.224|1064.958|1107.660|1116.630|0|169|40/60|
|docker|sqlite|hot|burst|128|read_delta|250|222.2|1.444|91.802|129.753|962.327|0|0|0/0|
|docker|sqlite|hot|burst|128|read_full|100|88.9|2.543|128.226|150.728|928.677|0|0|0/0|
|docker|sqlite|hot|burst|128|write_full|100|88.9|73.142|587.340|950.477|1079.602|0|0|0/0|
|docker|sqlite|hot|burst|128|write_patch|450|400.0|97.037|627.716|913.651|1114.362|0|0|0/0|
|docker|sqlite|hot|saturation|128|compact|100|77.9|281.692|1129.785|1259.141|1259.141|0|155|44/56|
|docker|sqlite|hot|saturation|128|read_delta|250|194.7|1.386|84.513|110.467|110.467|0|0|0/0|
|docker|sqlite|hot|saturation|128|read_full|100|77.9|1.902|125.289|139.166|139.166|0|0|0/0|
|docker|sqlite|hot|saturation|128|write_full|100|77.9|114.306|623.331|798.380|798.380|0|0|0/0|
|docker|sqlite|hot|saturation|128|write_patch|450|350.5|118.394|647.474|911.977|911.977|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
