# Mixed workload optimization comparison

1 baseline runs and 1 optimized runs; median completed requests/s per cell. Same fixture SHA-256: `2eac65ad652a6539884ac16a4f413d56119ecda971b09b4b932dff87d63e6fbb`. Exact 45/25/10/10/10 mix, durable commits, fresh private database per campaign.

16000 audited requests, zero request errors, 32 Pulsify materialization proofs and 1672 exact histories.

| Deployment / engine / clients / topology / admission | Before req/s | After req/s | Gain | p99 before → after ms |
|---|---:|---:|---:|---:|
| docker/postgres/128/spread/burst | 1599.1 | 2783.3 | +74.1% | 433.7 → 186.5 |
| docker/postgres/128/spread/saturation | 1981.5 | 2923.5 | +47.5% | 306.5 → 165.2 |
| docker/postgres/128/hot/burst | 671.3 | 875.1 | +30.4% | 721.7 → 651.7 |
| docker/postgres/128/hot/saturation | 655.6 | 876.0 | +33.6% | 690.1 → 520.5 |
| docker/sqlite/128/spread/burst | 437.4 | 919.8 | +110.3% | 1662.7 → 899.7 |
| docker/sqlite/128/spread/saturation | 438.0 | 899.4 | +105.3% | 1766.5 → 949.9 |
| docker/sqlite/128/hot/burst | 422.1 | 888.9 | +110.6% | 1871.7 → 1011.1 |
| docker/sqlite/128/hot/saturation | 459.3 | 778.9 | +69.6% | 1457.2 → 1073.4 |

**Every cell ≥30%: PASS.**

Compaction is attempted on every scheduled request; useful work varies with races. Useful compactions and removed segments are reported as min–max across repetitions.

| Cell | Useful before → after | Removed segments before → after |
|---|---:|---:|
| docker/postgres/128/spread/burst | 9–9 → 8–8 | 7969–7969 → 7968–7968 |
| docker/postgres/128/spread/saturation | 9–9 → 10–10 | 7969–7969 → 7970–7970 |
| docker/postgres/128/hot/burst | 5–5 → 6–6 | 1124–1124 → 1131–1131 |
| docker/postgres/128/hot/saturation | 5–5 → 5–5 | 1122–1122 → 1123–1123 |
| docker/sqlite/128/spread/burst | 40–40 → 18–18 | 8030–8030 → 7983–7983 |
| docker/sqlite/128/spread/saturation | 35–35 → 16–16 | 8018–8018 → 7976–7976 |
| docker/sqlite/128/hot/burst | 54–54 → 40–40 | 1206–1206 → 1157–1157 |
| docker/sqlite/128/hot/saturation | 45–45 → 44–44 | 1199–1199 → 1154–1154 |

These are finite batches on one workstation. Results characterize these storage adapters and deployments. The jittered SQLite busy handler can trade additional wakeups/CPU for shorter lock waits; no claim is made about long-running capacity or CPU efficiency.
