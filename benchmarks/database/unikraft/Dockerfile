# Database benchmark for one Unikraft Cloud instance: the Rust runner, its
# embedded engines and the server engines that fit in 1 vCPU / 4 GiB / 1 GiB disk.
# The same image runs under plain Docker on any x86-64 Linux host.
FROM --platform=linux/amd64 valkey/valkey:9.0.3 AS valkey
FROM --platform=linux/amd64 docker.dragonflydb.io/dragonflydb/dragonfly:v2.1.0 AS dragonfly
# Debian trixie: the Valkey binary needs its C library.
FROM --platform=linux/amd64 postgres:16-trixie
RUN apt-get update && apt-get install -y --no-install-recommends busybox libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=valkey /usr/local/bin/valkey-server /usr/local/bin/valkey-cli /usr/local/bin/
COPY --from=dragonfly /usr/local/bin/dragonfly /usr/local/bin/
COPY pulsify-db-bench /usr/local/bin/pulsify-db-bench
COPY fixture.json /fixture.json
COPY --chmod=755 entrypoint.sh /usr/local/bin/bench-entrypoint
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/bench-entrypoint"]
