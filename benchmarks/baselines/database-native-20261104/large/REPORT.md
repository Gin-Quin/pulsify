# Native Rust concurrent database benchmark

All backends use in-process Rust clients: postgres, rusqlite and foundationdb-rs/C API 730. No Python or per-key IPC. Real Pulsify fixtures and exact-history verification.

The mixed workload is exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads, 10% compaction attempts. Burst latency includes sender queue time; saturation latency is closed-loop service latency. Compaction no-ops are separated from useful work.

These are finite heavy bursts, not long-running steady-state capacity estimates. See context.json for hardware, database versions, source revision and campaign parameters.

Retry counts are a lower bound when a request exhausts its retry budget; failed compactions are recorded separately as errors.

| Environment | Database | Scenario | Topology | Mode | Clients | req/s | service p50 ms | service p95 ms | service p99 ms | end-to-end p99 ms | errors | retries | useful/noop compactions |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|docker|foundationdb|write_full|spread|burst|128|575.5|176.857|464.615|511.577|1737.663|0|0|0/0|
|docker|foundationdb|write_full|spread|saturation|128|1061.7|87.844|306.068|325.240|325.240|0|0|0/0|
|docker|foundationdb|write_full|hot|burst|128|1357.9|83.021|168.051|205.850|733.649|0|0|0/0|
|docker|foundationdb|write_full|hot|saturation|128|1318.7|91.045|124.415|165.838|165.838|0|0|0/0|
|docker|foundationdb|read_full|spread|burst|128|493.8|203.133|502.573|531.220|2021.974|0|0|0/0|
|docker|foundationdb|read_full|spread|saturation|128|295.9|424.589|481.208|493.158|493.158|0|0|0/0|
|docker|foundationdb|read_full|hot|burst|128|564.3|222.541|283.636|298.028|1766.990|0|0|0/0|
|docker|foundationdb|read_full|hot|saturation|128|264.1|479.115|597.321|611.641|611.641|0|0|0/0|
|docker|foundationdb|write_patch|spread|burst|128|8590.5|11.836|23.139|23.392|116.255|0|0|0/0|
|docker|foundationdb|write_patch|spread|saturation|128|8441.0|9.934|41.097|41.827|41.827|0|0|0/0|
|docker|foundationdb|write_patch|hot|burst|128|7641.2|13.832|31.322|32.223|130.735|0|0|0/0|
|docker|foundationdb|write_patch|hot|saturation|128|7303.0|14.158|32.716|34.063|34.063|0|0|0/0|
|docker|foundationdb|compact|spread|burst|128|370.4|339.781|464.370|532.406|2693.981|0|0|1000/0|
|docker|foundationdb|compact|spread|saturation|128|390.0|320.561|408.673|472.764|472.764|0|0|1000/0|
|docker|foundationdb|compact|hot|burst|128|2352.7|26.683|242.282|252.911|424.836|0|254|1/999|
|docker|foundationdb|compact|hot|saturation|128|1699.7|54.244|223.613|261.175|261.175|0|254|1/999|
|docker|foundationdb|read_delta|spread|burst|128|2485.5|43.181|98.681|100.148|401.935|0|0|0/0|
|docker|foundationdb|read_delta|spread|saturation|128|2742.5|46.670|52.575|55.459|55.459|0|0|0/0|
|docker|foundationdb|read_delta|hot|burst|128|3060.2|37.726|68.986|69.690|326.258|0|0|0/0|
|docker|foundationdb|read_delta|hot|saturation|128|2468.7|48.720|74.061|74.888|74.888|0|0|0/0|
|docker|foundationdb|mixed|spread|burst|128|103.5|105.893|8557.656|9170.560|9605.164|0|281|15/85|
|docker|foundationdb|mixed|spread|saturation|128|155.0|82.862|5246.455|5665.423|5665.423|0|239|16/84|
|docker|foundationdb|mixed|hot|burst|128|117.7|54.693|7619.226|7931.528|8402.436|0|331|2/98|
|docker|foundationdb|mixed|hot|saturation|128|115.1|77.755|7622.403|7891.743|7891.743|0|330|2/98|
|docker|postgres|write_full|spread|burst|128|1822.8|62.201|142.575|189.379|545.764|0|0|0/0|
|docker|postgres|write_full|spread|saturation|128|1924.1|57.179|127.352|165.895|165.895|0|0|0/0|
|docker|postgres|write_full|hot|burst|128|2045.5|52.349|137.308|170.450|486.566|0|0|0/0|
|docker|postgres|write_full|hot|saturation|128|1961.0|53.130|136.665|202.384|202.384|0|0|0/0|
|docker|postgres|read_full|spread|burst|128|1184.2|76.641|304.253|541.620|840.314|0|0|0/0|
|docker|postgres|read_full|spread|saturation|128|1177.5|89.063|220.669|298.828|298.828|0|0|0/0|
|docker|postgres|read_full|hot|burst|128|1344.6|83.950|157.299|189.842|733.607|0|0|0/0|
|docker|postgres|read_full|hot|saturation|128|1390.0|80.880|162.848|195.885|195.885|0|0|0/0|
|docker|postgres|write_patch|spread|burst|128|2603.7|39.496|84.478|99.004|372.602|0|0|0/0|
|docker|postgres|write_patch|spread|saturation|128|2926.9|38.533|60.199|68.269|68.269|0|0|0/0|
|docker|postgres|write_patch|hot|burst|128|384.2|308.252|435.878|493.099|2571.006|0|0|0/0|
|docker|postgres|write_patch|hot|saturation|128|367.9|339.427|372.951|419.822|419.822|0|0|0/0|
|docker|postgres|compact|spread|burst|128|933.2|129.016|217.880|270.938|1068.345|0|0|1000/0|
|docker|postgres|compact|spread|saturation|128|653.0|173.667|371.372|461.107|461.107|0|0|1000/0|
|docker|postgres|compact|hot|burst|128|2898.3|5.741|299.312|334.607|338.871|0|127|1/999|
|docker|postgres|compact|hot|saturation|128|5325.8|3.845|145.419|171.881|171.881|0|127|1/999|
|docker|postgres|read_delta|spread|burst|128|5795.3|16.654|46.476|64.538|164.026|0|0|0/0|
|docker|postgres|read_delta|spread|saturation|128|4453.8|15.793|93.282|153.054|153.054|0|0|0/0|
|docker|postgres|read_delta|hot|burst|128|5767.0|15.369|46.166|79.447|170.761|0|0|0/0|
|docker|postgres|read_delta|hot|saturation|128|4948.1|15.293|86.755|127.531|127.531|0|0|0/0|
|docker|postgres|mixed|spread|burst|128|1138.8|20.496|473.246|655.642|867.878|0|54|15/85|
|docker|postgres|mixed|spread|saturation|128|1220.4|57.929|350.908|520.285|520.285|0|41|8/92|
|docker|postgres|mixed|hot|burst|128|556.2|171.175|494.194|908.614|1792.915|0|157|5/95|
|docker|postgres|mixed|hot|saturation|128|580.9|260.597|486.756|801.626|801.626|0|158|5/95|
|docker|sqlite|write_full|spread|burst|128|148.3|7.418|3293.594|5618.542|5819.916|0|0|0/0|
|docker|sqlite|write_full|spread|saturation|128|137.9|11.975|3775.773|5628.364|5628.364|0|0|0/0|
|docker|sqlite|write_full|hot|burst|128|168.3|9.741|2993.612|5017.615|5118.095|0|0|0/0|
|docker|sqlite|write_full|hot|saturation|128|165.5|10.201|3281.331|5211.104|5211.104|0|0|0/0|
|docker|sqlite|read_full|spread|burst|128|1026.8|116.417|187.737|221.267|966.847|0|0|0/0|
|docker|sqlite|read_full|spread|saturation|128|1180.4|98.964|159.561|192.521|192.521|0|0|0/0|
|docker|sqlite|read_full|hot|burst|128|700.7|174.324|262.549|312.437|1421.747|0|0|0/0|
|docker|sqlite|read_full|hot|saturation|128|699.5|173.881|270.230|321.063|321.063|0|0|0/0|
|docker|sqlite|write_patch|spread|burst|128|278.2|0.604|1765.527|2983.308|2983.709|0|0|0/0|
|docker|sqlite|write_patch|spread|saturation|128|231.7|0.632|1562.088|3590.923|3590.923|0|0|0/0|
|docker|sqlite|write_patch|hot|burst|128|256.7|0.599|2266.629|3496.386|3496.490|0|0|0/0|
|docker|sqlite|write_patch|hot|saturation|128|262.8|0.617|1559.915|2887.807|2887.807|0|0|0/0|
|docker|sqlite|compact|spread|burst|128|170.2|10.263|3591.005|4908.964|5435.879|0|0|1000/0|
|docker|sqlite|compact|spread|saturation|128|145.5|11.350|3600.769|5338.642|5338.642|0|0|1000/0|
|docker|sqlite|compact|hot|burst|128|2709.0|0.557|106.847|217.447|217.537|0|127|1/999|
|docker|sqlite|compact|hot|saturation|128|4461.6|0.442|104.599|167.531|167.531|0|127|1/999|
|docker|sqlite|read_delta|spread|burst|128|1564.0|74.382|120.811|139.163|636.059|0|0|0/0|
|docker|sqlite|read_delta|spread|saturation|128|1959.0|62.239|84.529|95.752|95.752|0|0|0/0|
|docker|sqlite|read_delta|hot|burst|128|1118.8|107.908|177.624|213.836|891.252|0|0|0/0|
|docker|sqlite|read_delta|hot|saturation|128|1088.4|106.402|207.677|241.102|241.102|0|0|0/0|
|docker|sqlite|mixed|spread|burst|128|470.9|6.335|1465.618|1860.894|1971.381|0|33|31/69|
|docker|sqlite|mixed|spread|saturation|128|418.1|5.526|1564.170|1987.324|1987.324|0|31|24/76|
|docker|sqlite|mixed|hot|burst|128|438.8|3.002|1099.292|1659.483|1729.288|0|62|55/45|
|docker|sqlite|mixed|hot|saturation|128|303.5|7.093|1661.981|2466.144|2466.144|0|73|49/51|

72 completed cells, 72000 requests, 0 errors, 120 representative histories materialized through Pulsify. All accepted history was compared row-for-row in Rust.
