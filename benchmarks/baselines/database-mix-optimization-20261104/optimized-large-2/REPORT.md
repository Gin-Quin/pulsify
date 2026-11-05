# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|128|3481.7|12.019|124.991|181.147|284.135|0|49|14/86|
|bare-metal|postgres|mixed|spread|saturation|128|3743.1|13.364|105.388|150.245|150.245|0|44|16/84|
|bare-metal|postgres|mixed|hot|burst|128|2513.9|57.206|117.692|154.820|395.150|0|125|5/95|
|bare-metal|postgres|mixed|hot|saturation|128|2201.4|64.515|137.609|177.455|177.455|0|133|5/95|
|bare-metal|sqlite|mixed|spread|burst|128|2722.4|16.813|182.736|272.431|364.362|0|35|16/84|
|bare-metal|sqlite|mixed|spread|saturation|128|2941.2|12.867|182.896|260.232|260.232|0|29|9/91|
|bare-metal|sqlite|mixed|hot|burst|128|1760.4|24.973|264.939|541.546|564.256|0|336|32/68|
|bare-metal|sqlite|mixed|hot|saturation|128|1879.2|20.916|269.586|482.200|482.200|0|297|35/65|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|128|compact|100|348.2|55.217|193.875|212.520|279.204|0|49|14/86|
|bare-metal|postgres|spread|burst|128|read_delta|250|870.4|2.448|25.836|44.336|256.921|0|0|0/0|
|bare-metal|postgres|spread|burst|128|read_full|100|348.2|13.236|69.850|139.918|252.321|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_full|100|348.2|4.259|40.229|41.020|252.764|0|0|0/0|
|bare-metal|postgres|spread|burst|128|write_patch|450|1566.8|41.688|116.852|155.143|285.370|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|compact|100|374.3|41.957|175.697|188.657|188.657|0|44|16/84|
|bare-metal|postgres|spread|saturation|128|read_delta|250|935.8|2.451|23.382|32.616|32.616|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|read_full|100|374.3|11.542|62.642|66.749|66.749|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_full|100|374.3|4.051|39.258|45.997|45.997|0|0|0/0|
|bare-metal|postgres|spread|saturation|128|write_patch|450|1684.4|44.032|105.032|117.759|117.759|0|0|0/0|
|bare-metal|postgres|hot|burst|128|compact|100|251.4|105.347|159.148|176.697|397.769|0|125|5/95|
|bare-metal|postgres|hot|burst|128|read_delta|250|628.5|1.715|21.671|29.266|313.236|0|0|0/0|
|bare-metal|postgres|hot|burst|128|read_full|100|251.4|4.568|57.677|60.019|304.065|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_full|100|251.4|2.501|30.272|33.450|302.557|0|0|0/0|
|bare-metal|postgres|hot|burst|128|write_patch|450|1131.3|63.828|110.731|119.768|365.259|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|compact|100|220.1|116.586|181.585|184.838|184.838|0|133|5/95|
|bare-metal|postgres|hot|saturation|128|read_delta|250|550.3|1.970|25.157|32.137|32.137|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|read_full|100|220.1|4.996|70.654|73.970|73.970|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_full|100|220.1|2.819|38.004|44.890|44.890|0|0|0/0|
|bare-metal|postgres|hot|saturation|128|write_patch|450|990.6|76.446|127.850|139.533|139.533|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|compact|100|272.2|0.463|272.094|310.423|354.264|0|35|16/84|
|bare-metal|sqlite|spread|burst|128|read_delta|250|680.6|1.043|41.554|61.832|320.998|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|read_full|100|272.2|2.071|65.615|68.862|311.726|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_full|100|272.2|43.677|233.680|305.873|361.652|0|0|0/0|
|bare-metal|sqlite|spread|burst|128|write_patch|450|1225.1|40.833|196.718|264.069|365.731|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|compact|100|294.1|0.391|219.274|231.409|231.409|0|29|9/91|
|bare-metal|sqlite|spread|saturation|128|read_delta|250|735.3|0.963|47.168|59.766|59.766|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|read_full|100|294.1|1.669|55.764|60.088|60.088|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_full|100|294.1|38.100|189.406|213.070|213.070|0|0|0/0|
|bare-metal|sqlite|spread|saturation|128|write_patch|450|1323.6|36.002|202.968|284.516|284.516|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|compact|100|176.0|180.507|559.991|562.744|566.898|0|336|32/68|
|bare-metal|sqlite|hot|burst|128|read_delta|250|440.1|2.303|138.655|160.304|515.981|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|read_full|100|176.0|2.882|164.859|171.649|502.139|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_full|100|176.0|44.817|252.457|327.378|555.721|0|0|0/0|
|bare-metal|sqlite|hot|burst|128|write_patch|450|792.2|41.284|255.461|322.600|555.568|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|compact|100|187.9|143.834|515.356|529.212|529.212|0|297|35/65|
|bare-metal|sqlite|hot|saturation|128|read_delta|250|469.8|2.421|110.074|134.615|134.615|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|read_full|100|187.9|3.318|150.533|164.697|164.697|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_full|100|187.9|46.217|270.170|315.737|315.737|0|0|0/0|
|bare-metal|sqlite|hot|saturation|128|write_patch|450|845.6|36.417|263.420|410.980|410.980|0|0|0/0|

8 completed cells, 8000 requests, 0 errors, 16 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
