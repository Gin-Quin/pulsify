# Pulsify Cloud for Unikraft Cloud: the Rust server and PostgreSQL in one image.
# The build context is the repository root (or the context staged by
# `bun run cloud:unikraft`):
#   docker build -f packages/cloud-server/unikraft-cloud/Dockerfile -t pulsify-cloud .
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY crates/pulsify-protocol crates/pulsify-protocol
COPY packages/cloud-server/unikraft-cloud/server packages/cloud-server/unikraft-cloud/server
RUN cargo build --release --locked \
	--manifest-path packages/cloud-server/unikraft-cloud/server/Cargo.toml

FROM postgres:17-alpine
COPY --from=build /src/packages/cloud-server/unikraft-cloud/server/target/release/pulsify-cloud-server /usr/local/bin/
COPY --chmod=755 packages/cloud-server/unikraft-cloud/rootfs/ /
ENV PGDATA=/data/postgres \
	PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/pulsify-cloud-entrypoint"]
