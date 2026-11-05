# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|128|1130.6|19.387|647.049|754.249|878.722|0|52|11/89|
|bare-metal|postgres|mixed|spread|saturation|128|1537.4|29.173|426.237|485.052|485.052|0|43|11/89|
|bare-metal|postgres|mixed|hot|burst|128|1258.7|98.886|278.434|326.486|791.413|0|136|5/95|
|bare-metal|postgres|mixed|hot|saturation|128|1264.9|96.730|282.961|326.366|326.366|0|124|5/95|
|bare-metal|sqlite|mixed|spread|burst|128|1125.5|0.944|469.736|676.674|683.955|0|40|37/63|
|bare-metal|sqlite|mixed|spread|saturation|128|1007.3|0.834|496.453|778.564|778.564|0|37|39/61|
|bare-metal|sqlite|mixed|hot|burst|128|922.8|1.400|460.368|668.466|668.793|0|75|52/48|
|bare-metal|sqlite|mixed|hot|saturation|128|1129.6|1.393|389.958|580.202|580.202|0|75|47/53|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|128|compact|100|113.1|132.808|771.131|808.315|880.854|0|52|11/89|
|bare-metal|postgres|spread|burst|128|read_delta|250|282.7|2.745|22.996|52.032|837.063|0|0|0/0|
|bare-metal|postgres|spread|burst|128|read_full|100|113.1|9.738|86.327|91.221|832.651|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_full|100|113.1|6.330|38.063|38.529|835.053|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_patch|450|508.8|61.350|643.851|729.823|881.859|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|compact|100|153.7|33.805|492.415|499.292|499.292|0|43|11/89|
|bare-metal|postgres|spread|saturation|128|read_delta|250|384.4|2.578|24.553|28.719|28.719|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|read_full|100|153.7|8.013|60.475|64.009|64.009|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_full|100|153.7|5.655|38.711|45.093|45.093|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_patch|450|691.8|60.299|421.812|438.254|438.254|0|0|0/0|
|bare-metal|postgres|hot|burst|128|compact|100|125.9|278.289|332.360|353.922|794.247|0|136|5/95|
|bare-metal|postgres|hot|burst|128|read_delta|250|314.7|1.416|23.371|27.142|593.581|0|0|0/0|
|bare-metal|postgres|hot|burst|128|read_full|100|125.9|3.633|58.793|62.564|574.639|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_full|100|125.9|2.578|51.984|58.489|574.162|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_patch|450|566.4|110.073|269.694|277.184|731.144|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|compact|100|126.5|275.904|332.516|356.566|356.566|0|124|5/95|
|bare-metal|postgres|hot|saturation|128|read_delta|250|316.2|1.520|22.609|23.448|23.448|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|read_full|100|126.5|3.679|59.320|62.001|62.001|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_full|100|126.5|2.700|36.991|55.689|55.689|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_patch|450|569.2|114.728|271.158|283.699|283.699|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|compact|100|112.5|1.575|556.675|755.287|787.544|0|40|37/63|
|bare-metal|sqlite|spread|burst|128|read_delta|250|281.4|0.706|75.602|84.395|426.717|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|112.5|3.724|92.768|100.460|419.060|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|112.5|1.126|566.764|656.202|778.768|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|506.5|0.258|484.397|680.718|683.955|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|100.7|0.693|542.074|638.173|638.173|0|37|39/61|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|251.8|0.717|63.852|76.535|76.535|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|100.7|1.791|76.478|87.759|87.759|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|100.7|1.558|669.216|783.678|783.678|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|453.3|0.173|571.725|872.506|872.506|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|92.3|4.422|504.754|564.531|591.488|0|75|52/48|
|bare-metal|sqlite|hot|burst|128|read_delta|250|230.7|1.445|113.609|120.263|399.084|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|92.3|1.947|143.717|148.606|389.946|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|92.3|1.170|457.002|673.423|673.733|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|415.3|0.169|469.655|976.166|976.421|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|113.0|12.335|494.358|580.202|580.202|0|75|47/53|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|282.4|1.518|90.280|104.178|104.178|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|113.0|1.949|127.007|136.613|136.613|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|113.0|1.139|465.357|570.412|570.412|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|508.3|0.129|463.214|679.765|679.765|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
