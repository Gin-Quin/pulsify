# Mixed workload optimization comparison

1 baseline runs and 1 optimized runs; median completed requests/s per cell. Same fixture SHA-256: `285d70746b17625a44ca5e39cb62171b9f64df23a69e65a111746dd5053eae5e`. Exact 45/25/10/10/10 mix, durable commits, fresh private database per campaign.

48000 audited requests, zero request errors, 96 Pulsify materialization proofs and 5016 exact histories.

| Deployment / engine / clients / topology / admission | Before req/s | After req/s | Gain | p99 before → after ms |
|---|---:|---:|---:|---:|
| bare-metal/postgres/1/spread/burst | 1458.2 | 3890.1 | +166.8% | 2.4 → 0.5 |
| bare-metal/postgres/1/spread/saturation | 1469.8 | 3890.5 | +164.7% | 2.4 → 0.5 |
| bare-metal/postgres/1/hot/burst | 1453.7 | 2920.0 | +100.9% | 2.1 → 0.7 |
| bare-metal/postgres/1/hot/saturation | 1467.1 | 2928.6 | +99.6% | 2.1 → 0.7 |
| bare-metal/postgres/16/spread/burst | 5086.6 | 7377.0 | +45.0% | 27.7 → 9.1 |
| bare-metal/postgres/16/spread/saturation | 5116.5 | 15742.2 | +207.7% | 27.8 → 3.2 |
| bare-metal/postgres/16/hot/burst | 1772.7 | 3882.3 | +119.0% | 106.8 → 43.9 |
| bare-metal/postgres/16/hot/saturation | 1864.5 | 3431.1 | +84.0% | 78.3 → 61.6 |
| bare-metal/postgres/64/spread/burst | 5401.8 | 11788.0 | +118.2% | 57.1 → 18.9 |
| bare-metal/postgres/64/spread/saturation | 5348.1 | 12686.4 | +137.2% | 57.5 → 16.9 |
| bare-metal/postgres/64/hot/burst | 1693.6 | 3376.1 | +99.3% | 405.9 → 204.7 |
| bare-metal/postgres/64/hot/saturation | 1829.7 | 3180.1 | +73.8% | 366.0 → 217.3 |
| bare-metal/sqlite/1/spread/burst | 9196.3 | 11420.5 | +24.2% | 1.0 → 0.7 |
| bare-metal/sqlite/1/spread/saturation | 9202.9 | 11197.4 | +21.7% | 0.9 → 0.7 |
| bare-metal/sqlite/1/hot/burst | 5421.9 | 5897.0 | +8.8% | 0.6 → 0.6 |
| bare-metal/sqlite/1/hot/saturation | 5509.3 | 5960.7 | +8.2% | 0.6 → 0.6 |
| bare-metal/sqlite/16/spread/burst | 7634.2 | 13918.6 | +82.3% | 40.5 → 13.3 |
| bare-metal/sqlite/16/spread/saturation | 4954.4 | 12848.9 | +159.3% | 61.1 → 15.4 |
| bare-metal/sqlite/16/hot/burst | 6555.5 | 9707.6 | +48.1% | 61.7 → 17.5 |
| bare-metal/sqlite/16/hot/saturation | 4870.4 | 9489.1 | +94.8% | 61.3 → 19.2 |
| bare-metal/sqlite/64/spread/burst | 3842.8 | 11963.4 | +211.3% | 197.0 → 43.1 |
| bare-metal/sqlite/64/spread/saturation | 3864.4 | 12074.7 | +212.5% | 149.0 → 42.2 |
| bare-metal/sqlite/64/hot/burst | 2772.5 | 7231.3 | +160.8% | 197.9 → 83.9 |
| bare-metal/sqlite/64/hot/saturation | 2748.1 | 7620.4 | +177.3% | 195.8 → 82.2 |

**Every cell ≥30%: FAIL.**

Compaction is attempted on every scheduled request; useful work varies with races. Useful compactions and removed segments are reported as min–max across repetitions.

| Cell | Useful before → after | Removed segments before → after |
|---|---:|---:|
| bare-metal/postgres/1/spread/burst | 66–66 → 66–66 | 1068–1068 → 1068–1068 |
| bare-metal/postgres/1/spread/saturation | 66–66 → 66–66 | 1068–1068 → 1068–1068 |
| bare-metal/postgres/1/hot/burst | 68–68 → 68–68 | 458–458 → 458–458 |
| bare-metal/postgres/1/hot/saturation | 68–68 → 68–68 | 458–458 → 458–458 |
| bare-metal/postgres/16/spread/burst | 50–50 → 54–54 | 882–882 → 874–874 |
| bare-metal/postgres/16/spread/saturation | 56–56 → 51–51 | 876–876 → 873–873 |
| bare-metal/postgres/16/hot/burst | 73–73 → 70–70 | 312–312 → 314–314 |
| bare-metal/postgres/16/hot/saturation | 58–58 → 81–81 | 308–308 → 315–315 |
| bare-metal/postgres/64/spread/burst | 17–17 → 16–16 | 778–778 → 779–779 |
| bare-metal/postgres/64/spread/saturation | 21–21 → 22–22 | 784–784 → 788–788 |
| bare-metal/postgres/64/hot/burst | 13–13 → 13–13 | 276–276 → 277–277 |
| bare-metal/postgres/64/hot/saturation | 13–13 → 13–13 | 273–273 → 276–276 |
| bare-metal/sqlite/1/spread/burst | 66–66 → 66–66 | 1068–1068 → 1068–1068 |
| bare-metal/sqlite/1/spread/saturation | 66–66 → 66–66 | 1068–1068 → 1068–1068 |
| bare-metal/sqlite/1/hot/burst | 68–68 → 68–68 | 458–458 → 458–458 |
| bare-metal/sqlite/1/hot/saturation | 68–68 → 68–68 | 458–458 → 458–458 |
| bare-metal/sqlite/16/spread/burst | 62–62 → 44–44 | 975–975 → 898–898 |
| bare-metal/sqlite/16/spread/saturation | 62–62 → 48–48 | 992–992 → 890–890 |
| bare-metal/sqlite/16/hot/burst | 58–58 → 61–61 | 423–423 → 381–381 |
| bare-metal/sqlite/16/hot/saturation | 72–72 → 57–57 | 415–415 → 396–396 |
| bare-metal/sqlite/64/spread/burst | 52–52 → 28–28 | 909–909 → 794–794 |
| bare-metal/sqlite/64/spread/saturation | 49–49 → 24–24 | 896–896 → 801–801 |
| bare-metal/sqlite/64/hot/burst | 59–59 → 47–47 | 372–372 → 322–322 |
| bare-metal/sqlite/64/hot/saturation | 55–55 → 49–49 | 376–376 → 312–312 |

These are finite batches on one workstation. Results characterize these storage adapters and deployments. The jittered SQLite busy handler can trade additional wakeups/CPU for shorter lock waits; no claim is made about long-running capacity or CPU efficiency.
