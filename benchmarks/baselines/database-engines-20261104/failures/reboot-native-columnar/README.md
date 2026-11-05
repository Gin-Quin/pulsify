# Interrupted native columnar heavy load

At 128 clients, spread compaction recorded 584 errors in 1,000 requests. The native pgrust process showed about 24 GiB swapped memory in an OS region sample (mimalloc accounting was incomplete), and SQL statement timeouts occurred before profiling. Cancellations released memory; no server kill was issued. The Mac then rebooted at 21:49:46 Europe/Paris. Reboot cause is not established. The checkpoint has 13 completed cells; later operation groups were not completed. These are actual stress failures, not silently discarded measurements.
