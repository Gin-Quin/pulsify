FROM rust:1.95-slim-bookworm AS build
# RocksDB, LMDB and LevelDB are compiled from source: C++ toolchain, CMake and
# libclang for bindgen.
# LevelDB 1.22's CMake file passes a Clang-only warning flag, so Clang compiles the C++.
RUN apt-get update && apt-get install -y --no-install-recommends clang g++ make cmake libclang-dev && rm -rf /var/lib/apt/lists/*
ENV CC=clang CXX=clang++
WORKDIR /source
COPY crates/pulsify-protocol crates/pulsify-protocol
COPY crates/pulsify-db-bench/Cargo.toml crates/pulsify-db-bench/Cargo.lock crates/pulsify-db-bench/
COPY crates/pulsify-db-bench/src crates/pulsify-db-bench/src
# Avoid retaining a second full toolchain's compiled target directory on disk.
RUN --mount=type=tmpfs,target=/target mkdir -p /target/tmp /target/cargo && TMPDIR=/target/tmp CARGO_HOME=/target/cargo CARGO_TARGET_DIR=/target cargo build --release --locked --manifest-path crates/pulsify-db-bench/Cargo.toml && cp /target/release/pulsify-db-bench /pulsify-db-bench
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=build /pulsify-db-bench /usr/local/bin/pulsify-db-bench
ENTRYPOINT ["pulsify-db-bench"]
