# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres (PostgreSQL wire protocol) and rusqlite. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|mixed|spread|burst|1|3890.1|0.225|0.390|0.455|254.519|0|0|66/34|
|bare-metal|postgres|mixed|spread|saturation|1|3890.5|0.225|0.388|0.474|0.474|0|0|66/34|
|bare-metal|postgres|mixed|hot|burst|1|2920.0|0.254|0.665|0.716|337.565|0|0|68/32|
|bare-metal|postgres|mixed|hot|saturation|1|2928.6|0.258|0.669|0.740|0.740|0|0|68/32|
|bare-metal|postgres|mixed|spread|burst|16|7377.0|1.493|5.713|9.059|134.049|0|18|54/46|
|bare-metal|postgres|mixed|spread|saturation|16|15742.2|0.816|2.143|3.206|3.206|0|20|51/49|
|bare-metal|postgres|mixed|hot|burst|16|3882.3|2.388|18.582|43.921|253.625|0|607|70/30|
|bare-metal|postgres|mixed|hot|saturation|16|3431.1|2.304|17.279|61.556|61.556|0|757|81/19|
|bare-metal|postgres|mixed|spread|burst|64|11788.0|2.241|14.850|18.852|82.324|0|31|16/84|
|bare-metal|postgres|mixed|spread|saturation|64|12686.4|2.084|13.637|16.897|16.897|0|33|22/78|
|bare-metal|postgres|mixed|hot|burst|64|3376.1|16.512|43.820|204.650|293.799|0|455|13/87|
|bare-metal|postgres|mixed|hot|saturation|64|3180.1|17.132|50.735|217.294|217.294|0|455|13/87|
|bare-metal|sqlite|mixed|spread|burst|1|11420.5|0.070|0.165|0.675|86.577|0|0|66/34|
|bare-metal|sqlite|mixed|spread|saturation|1|11197.4|0.073|0.167|0.690|0.690|0|0|66/34|
|bare-metal|sqlite|mixed|hot|burst|1|5897.0|0.094|0.533|0.574|166.441|0|0|68/32|
|bare-metal|sqlite|mixed|hot|saturation|1|5960.7|0.091|0.530|0.584|0.584|0|0|68/32|
|bare-metal|sqlite|mixed|spread|burst|16|13918.6|0.135|6.010|13.331|68.773|0|27|44/56|
|bare-metal|sqlite|mixed|spread|saturation|16|12848.9|0.144|6.596|15.377|15.377|0|21|48/52|
|bare-metal|sqlite|mixed|hot|burst|16|9707.6|0.412|8.131|17.528|100.461|0|99|61/39|
|bare-metal|sqlite|mixed|hot|saturation|16|9489.1|0.357|7.812|19.205|19.205|0|95|57/43|
|bare-metal|sqlite|mixed|spread|burst|64|11963.4|0.186|25.125|43.076|81.230|0|28|28/72|
|bare-metal|sqlite|mixed|spread|saturation|64|12074.7|0.185|25.461|42.168|42.168|0|37|24/76|
|bare-metal|sqlite|mixed|hot|burst|64|7231.3|1.234|39.424|83.901|135.486|0|236|47/53|
|bare-metal|sqlite|mixed|hot|saturation|64|7620.4|1.286|39.064|82.183|82.183|0|212|49/51|

## Operations within the mixed workload

Per-operation req/s is its completed share over the entire mixed cell duration. Service latency includes database lock waits and retries; burst end-to-end latency also includes admission queue time.

| Environment | Database | Topology | Mode | Clients | Operation | Count | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|bare-metal|postgres|spread|burst|1|compact|100|389.0|0.341|1.045|1.126|241.515|0|0|66/34|
|bare-metal|postgres|spread|burst|1|read_delta|250|972.5|0.219|0.253|0.271|255.920|0|0|0/0|
|bare-metal|postgres|spread|burst|1|read_full|100|389.0|0.288|0.411|0.442|248.186|0|0|0/0|
|bare-metal|postgres|spread|burst|1|write_full|100|389.0|0.378|0.428|0.455|247.738|0|0|0/0|
|bare-metal|postgres|spread|burst|1|write_patch|450|1750.5|0.220|0.241|0.259|254.519|0|0|0/0|
|bare-metal|postgres|spread|saturation|1|compact|100|389.0|0.337|1.074|1.194|1.194|0|0|66/34|
|bare-metal|postgres|spread|saturation|1|read_delta|250|972.6|0.220|0.259|0.279|0.279|0|0|0/0|
|bare-metal|postgres|spread|saturation|1|read_full|100|389.0|0.286|0.418|0.438|0.438|0|0|0/0|
|bare-metal|postgres|spread|saturation|1|write_full|100|389.0|0.379|0.427|0.474|0.474|0|0|0/0|
|bare-metal|postgres|spread|saturation|1|write_patch|450|1750.7|0.219|0.242|0.263|0.263|0|0|0/0|
|bare-metal|postgres|hot|burst|1|compact|100|292.0|0.366|0.479|0.508|313.887|0|0|68/32|
|bare-metal|postgres|hot|burst|1|read_delta|250|730.0|0.487|0.688|0.716|340.379|0|0|0/0|
|bare-metal|postgres|hot|burst|1|read_full|100|292.0|0.470|0.750|0.758|326.215|0|0|0/0|
|bare-metal|postgres|hot|burst|1|write_full|100|292.0|0.390|0.430|0.480|325.018|0|0|0/0|
|bare-metal|postgres|hot|burst|1|write_patch|450|1314.0|0.225|0.248|0.263|337.565|0|0|0/0|
|bare-metal|postgres|hot|saturation|1|compact|100|292.9|0.370|0.458|0.535|0.535|0|0|68/32|
|bare-metal|postgres|hot|saturation|1|read_delta|250|732.1|0.479|0.710|0.781|0.781|0|0|0/0|
|bare-metal|postgres|hot|saturation|1|read_full|100|292.9|0.460|0.744|0.751|0.751|0|0|0/0|
|bare-metal|postgres|hot|saturation|1|write_full|100|292.9|0.388|0.454|0.470|0.470|0|0|0/0|
|bare-metal|postgres|hot|saturation|1|write_patch|450|1317.9|0.224|0.249|0.284|0.284|0|0|0/0|
|bare-metal|postgres|spread|burst|16|compact|100|737.7|2.308|6.083|8.574|131.890|0|18|54/46|
|bare-metal|postgres|spread|burst|16|read_delta|250|1844.3|0.895|2.772|5.002|134.214|0|0|0/0|
|bare-metal|postgres|spread|burst|16|read_full|100|737.7|1.342|3.036|3.826|132.632|0|0|0/0|
|bare-metal|postgres|spread|burst|16|write_full|100|737.7|1.903|5.124|5.696|132.467|0|0|0/0|
|bare-metal|postgres|spread|burst|16|write_patch|450|3319.7|1.878|6.498|9.557|134.605|0|0|0/0|
|bare-metal|postgres|spread|saturation|16|compact|100|1574.2|1.330|3.568|4.257|4.257|0|20|51/49|
|bare-metal|postgres|spread|saturation|16|read_delta|250|3935.6|0.680|0.944|1.749|1.749|0|0|0/0|
|bare-metal|postgres|spread|saturation|16|read_full|100|1574.2|0.769|1.659|2.448|2.448|0|0|0/0|
|bare-metal|postgres|spread|saturation|16|write_full|100|1574.2|1.081|1.499|2.537|2.537|0|0|0/0|
|bare-metal|postgres|spread|saturation|16|write_patch|450|7084.0|0.867|2.039|3.003|3.003|0|0|0/0|
|bare-metal|postgres|hot|burst|16|compact|100|388.2|18.582|51.077|62.678|257.480|0|607|70/30|
|bare-metal|postgres|hot|burst|16|read_delta|250|970.6|1.182|2.683|2.814|252.421|0|0|0/0|
|bare-metal|postgres|hot|burst|16|read_full|100|388.2|0.824|2.217|2.573|242.915|0|0|0/0|
|bare-metal|postgres|hot|burst|16|write_full|100|388.2|0.579|1.026|1.431|240.704|0|0|0/0|
|bare-metal|postgres|hot|burst|16|write_patch|450|1747.0|2.888|4.242|5.015|253.504|0|0|0/0|
|bare-metal|postgres|hot|saturation|16|compact|100|343.1|17.279|72.947|93.543|93.543|0|757|81/19|
|bare-metal|postgres|hot|saturation|16|read_delta|250|857.8|1.100|2.704|3.366|3.366|0|0|0/0|
|bare-metal|postgres|hot|saturation|16|read_full|100|343.1|0.834|2.346|2.908|2.908|0|0|0/0|
|bare-metal|postgres|hot|saturation|16|write_full|100|343.1|0.582|1.154|3.607|3.607|0|0|0/0|
|bare-metal|postgres|hot|saturation|16|write_patch|450|1544.0|2.850|5.004|7.005|7.005|0|0|0/0|
|bare-metal|postgres|spread|burst|64|compact|100|1178.8|0.866|19.555|24.223|84.561|0|31|16/84|
|bare-metal|postgres|spread|burst|64|read_delta|250|2947.0|1.107|4.992|5.941|74.765|0|0|0/0|
|bare-metal|postgres|spread|burst|64|read_full|100|1178.8|1.279|6.501|6.735|72.832|0|0|0/0|
|bare-metal|postgres|spread|burst|64|write_full|100|1178.8|1.873|5.309|8.932|73.363|0|0|0/0|
|bare-metal|postgres|spread|burst|64|write_patch|450|5304.6|8.363|15.985|16.931|82.828|0|0|0/0|
|bare-metal|postgres|spread|saturation|64|compact|100|1268.6|0.848|18.024|22.907|22.907|0|33|22/78|
|bare-metal|postgres|spread|saturation|64|read_delta|250|3171.6|1.010|4.609|6.039|6.039|0|0|0/0|
|bare-metal|postgres|spread|saturation|64|read_full|100|1268.6|1.098|5.584|6.479|6.479|0|0|0/0|
|bare-metal|postgres|spread|saturation|64|write_full|100|1268.6|1.685|5.317|9.211|9.211|0|0|0/0|
|bare-metal|postgres|spread|saturation|64|write_patch|450|5708.9|7.767|14.380|15.556|15.556|0|0|0/0|
|bare-metal|postgres|hot|burst|64|compact|100|337.6|43.820|224.296|226.379|295.874|0|455|13/87|
|bare-metal|postgres|hot|burst|64|read_delta|250|844.0|0.979|4.517|4.707|255.832|0|0|0/0|
|bare-metal|postgres|hot|burst|64|read_full|100|337.6|0.806|5.437|5.893|237.846|0|0|0/0|
|bare-metal|postgres|hot|burst|64|write_full|100|337.6|0.637|3.685|8.067|235.808|0|0|0/0|
|bare-metal|postgres|hot|burst|64|write_patch|450|1519.3|19.267|23.073|24.666|265.401|0|0|0/0|
|bare-metal|postgres|hot|saturation|64|compact|100|318.0|50.735|236.569|239.153|239.153|0|455|13/87|
|bare-metal|postgres|hot|saturation|64|read_delta|250|795.0|1.180|4.956|5.854|5.854|0|0|0/0|
|bare-metal|postgres|hot|saturation|64|read_full|100|318.0|0.835|5.684|6.292|6.292|0|0|0/0|
|bare-metal|postgres|hot|saturation|64|write_full|100|318.0|0.694|4.584|8.736|8.736|0|0|0/0|
|bare-metal|postgres|hot|saturation|64|write_patch|450|1431.1|20.055|27.151|28.031|28.031|0|0|0/0|
|bare-metal|sqlite|spread|burst|1|compact|100|1142.1|0.075|0.680|0.736|81.934|0|0|66/34|
|bare-metal|sqlite|spread|burst|1|read_delta|250|2855.1|0.099|0.132|0.148|87.114|0|0|0/0|
|bare-metal|sqlite|spread|burst|1|read_full|100|1142.1|0.150|0.232|0.247|84.403|0|0|0/0|
|bare-metal|sqlite|spread|burst|1|write_full|100|1142.1|0.099|0.145|1.004|84.206|0|0|0/0|
|bare-metal|sqlite|spread|burst|1|write_patch|450|5139.2|0.046|0.071|0.094|86.577|0|0|0/0|
|bare-metal|sqlite|spread|saturation|1|compact|100|1119.7|0.077|0.701|0.771|0.771|0|0|66/34|
|bare-metal|sqlite|spread|saturation|1|read_delta|250|2799.3|0.101|0.131|0.147|0.147|0|0|0/0|
|bare-metal|sqlite|spread|saturation|1|read_full|100|1119.7|0.150|0.233|0.239|0.239|0|0|0/0|
|bare-metal|sqlite|spread|saturation|1|write_full|100|1119.7|0.105|0.149|0.889|0.889|0|0|0/0|
|bare-metal|sqlite|spread|saturation|1|write_patch|450|5038.8|0.046|0.078|0.107|0.107|0|0|0/0|
|bare-metal|sqlite|hot|burst|1|compact|100|589.7|0.103|0.183|0.234|151.899|0|0|68/32|
|bare-metal|sqlite|hot|burst|1|read_delta|250|1474.2|0.361|0.551|0.572|168.284|0|0|0/0|
|bare-metal|sqlite|hot|burst|1|read_full|100|589.7|0.321|0.577|0.608|159.582|0|0|0/0|
|bare-metal|sqlite|hot|burst|1|write_full|100|589.7|0.109|0.156|0.889|158.782|0|0|0/0|
|bare-metal|sqlite|hot|burst|1|write_patch|450|2653.6|0.043|0.084|0.102|166.441|0|0|0/0|
|bare-metal|sqlite|hot|saturation|1|compact|100|596.1|0.104|0.183|0.353|0.353|0|0|68/32|
|bare-metal|sqlite|hot|saturation|1|read_delta|250|1490.2|0.355|0.547|0.579|0.579|0|0|0/0|
|bare-metal|sqlite|hot|saturation|1|read_full|100|596.1|0.319|0.584|0.598|0.598|0|0|0/0|
|bare-metal|sqlite|hot|saturation|1|write_full|100|596.1|0.109|0.151|0.943|0.943|0|0|0/0|
|bare-metal|sqlite|hot|saturation|1|write_patch|450|2682.3|0.044|0.083|0.092|0.092|0|0|0/0|
|bare-metal|sqlite|spread|burst|16|compact|100|1391.9|0.201|11.788|18.593|66.806|0|27|44/56|
|bare-metal|sqlite|spread|burst|16|read_delta|250|3479.6|0.139|0.269|2.168|68.214|0|0|0/0|
|bare-metal|sqlite|spread|burst|16|read_full|100|1391.9|0.189|0.883|1.927|66.995|0|0|0/0|
|bare-metal|sqlite|spread|burst|16|write_full|100|1391.9|0.148|4.953|9.161|68.164|0|0|0/0|
|bare-metal|sqlite|spread|burst|16|write_patch|450|6263.3|0.068|7.747|16.771|69.538|0|0|0/0|
|bare-metal|sqlite|spread|saturation|16|compact|100|1284.9|0.189|9.616|23.810|23.810|0|21|48/52|
|bare-metal|sqlite|spread|saturation|16|read_delta|250|3212.2|0.152|0.267|1.854|1.854|0|0|0/0|
|bare-metal|sqlite|spread|saturation|16|read_full|100|1284.9|0.196|1.024|1.464|1.464|0|0|0/0|
|bare-metal|sqlite|spread|saturation|16|write_full|100|1284.9|0.157|8.132|13.799|13.799|0|0|0/0|
|bare-metal|sqlite|spread|saturation|16|write_patch|450|5782.0|0.071|8.216|18.930|18.930|0|0|0/0|
|bare-metal|sqlite|hot|burst|16|compact|100|970.8|0.617|21.099|26.742|101.960|0|99|61/39|
|bare-metal|sqlite|hot|burst|16|read_delta|250|2426.9|0.801|2.072|2.356|100.782|0|0|0/0|
|bare-metal|sqlite|hot|burst|16|read_full|100|970.8|0.535|1.787|2.140|95.967|0|0|0/0|
|bare-metal|sqlite|hot|burst|16|write_full|100|970.8|0.185|10.387|16.394|99.488|0|0|0/0|
|bare-metal|sqlite|hot|burst|16|write_patch|450|4368.4|0.086|7.563|14.289|100.071|0|0|0/0|
|bare-metal|sqlite|hot|saturation|16|compact|100|948.9|0.572|22.095|41.983|41.983|0|95|57/43|
|bare-metal|sqlite|hot|saturation|16|read_delta|250|2372.3|0.780|1.891|2.451|2.451|0|0|0/0|
|bare-metal|sqlite|hot|saturation|16|read_full|100|948.9|0.552|1.606|2.032|2.032|0|0|0/0|
|bare-metal|sqlite|hot|saturation|16|write_full|100|948.9|0.198|8.576|13.429|13.429|0|0|0/0|
|bare-metal|sqlite|hot|saturation|16|write_patch|450|4270.1|0.087|7.841|15.597|15.597|0|0|0/0|
|bare-metal|sqlite|spread|burst|64|compact|100|1196.3|0.117|31.136|43.474|82.023|0|28|28/72|
|bare-metal|sqlite|spread|burst|64|read_delta|250|2990.9|0.158|5.042|6.080|74.033|0|0|0/0|
|bare-metal|sqlite|spread|burst|64|read_full|100|1196.3|0.222|3.364|4.732|72.246|0|0|0/0|
|bare-metal|sqlite|spread|burst|64|write_full|100|1196.3|0.209|22.197|33.267|77.075|0|0|0/0|
|bare-metal|sqlite|spread|burst|64|write_patch|450|5383.5|1.063|32.752|46.046|82.254|0|0|0/0|
|bare-metal|sqlite|spread|saturation|64|compact|100|1207.5|0.196|31.008|54.362|54.362|0|37|24/76|
|bare-metal|sqlite|spread|saturation|64|read_delta|250|3018.7|0.160|5.511|6.290|6.290|0|0|0/0|
|bare-metal|sqlite|spread|saturation|64|read_full|100|1207.5|0.210|3.674|4.855|4.855|0|0|0/0|
|bare-metal|sqlite|spread|saturation|64|write_full|100|1207.5|2.890|33.581|44.989|44.989|0|0|0/0|
|bare-metal|sqlite|spread|saturation|64|write_patch|450|5433.6|0.191|28.885|42.703|42.703|0|0|0/0|
|bare-metal|sqlite|hot|burst|64|compact|100|723.1|20.346|109.110|129.231|137.663|0|236|47/53|
|bare-metal|sqlite|hot|burst|64|read_delta|250|1807.8|0.999|4.442|5.632|128.389|0|0|0/0|
|bare-metal|sqlite|hot|burst|64|read_full|100|723.1|0.869|3.460|4.199|125.065|0|0|0/0|
|bare-metal|sqlite|hot|burst|64|write_full|100|723.1|1.271|39.424|44.510|136.111|0|0|0/0|
|bare-metal|sqlite|hot|burst|64|write_patch|450|3254.1|2.240|32.468|47.746|135.315|0|0|0/0|
|bare-metal|sqlite|hot|saturation|64|compact|100|762.0|18.159|109.683|117.889|117.889|0|212|49/51|
|bare-metal|sqlite|hot|saturation|64|read_delta|250|1905.1|1.007|4.194|4.756|4.756|0|0|0/0|
|bare-metal|sqlite|hot|saturation|64|read_full|100|762.0|0.806|2.665|2.986|2.986|0|0|0/0|
|bare-metal|sqlite|hot|saturation|64|write_full|100|762.0|2.365|31.655|53.257|53.257|0|0|0/0|
|bare-metal|sqlite|hot|saturation|64|write_patch|450|3429.2|2.794|31.928|51.935|51.935|0|0|0/0|

24 completed cells, 24000 requests, 0 errors, 48 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
