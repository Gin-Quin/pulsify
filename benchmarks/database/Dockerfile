FROM oven/bun:1.4.4
WORKDIR /workspace
COPY package.json bun.lock ./
COPY packages/pulse/package.json packages/pulse/package.json
COPY benchmarks/package.json benchmarks/package.json
RUN bun install --frozen-lockfile
COPY packages/pulse/source packages/pulse/source
COPY benchmarks/database benchmarks/database
ENTRYPOINT ["bun"]
CMD ["benchmarks/database/runner.ts"]
