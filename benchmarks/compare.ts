const [baselinePath, currentPath, ...flags] = process.argv.slice(2);
if (!baselinePath || !currentPath)
	throw new Error(
		"Usage: bun run bench:compare baseline.json current.json [--strict]",
	);
const [baseline, current] = await Promise.all([
	Bun.file(baselinePath).json(),
	Bun.file(currentPath).json(),
]);
const sameEnvironment = [
	"runtime",
	"codec",
	"jsonJoy",
	"yjs",
	"loro",
	"loroBackend",
	"platform",
	"arch",
	"cpu",
].every((key) => baseline.environment[key] === current.environment[key]);
if (
	baseline.schemaVersion !== current.schemaVersion ||
	!sameEnvironment ||
	JSON.stringify(baseline.parameters) !== JSON.stringify(current.parameters)
)
	throw new Error(
		"Benchmark environments or parameters differ; collect a comparable baseline first",
	);
const regressions: object[] = [];
for (const previous of baseline.results) {
	const next = current.results.find(
		(result: any) => result.name === previous.name,
	);
	if (!next) throw new Error(`Missing benchmark: ${previous.name}`);
	if (next.iterations !== previous.iterations)
		throw new Error(`Benchmark iteration counts differ: ${previous.name}`);
	const noiseFloorUs = previous.name.includes("/create/")
		? 5
		: previous.name.startsWith("sync/")
			? 100
			: previous.sampleMeanUs.median < 1
				? 0.1
				: 0.5;
	const threshold = previous.sampleMeanUs.median * 1.2 + noiseFloorUs;
	if (next.sampleMeanUs.median > threshold)
		regressions.push({
			name: previous.name,
			beforeUs: previous.sampleMeanUs.median,
			afterUs: next.sampleMeanUs.median,
			thresholdUs: threshold,
		});
	if (
		previous.metrics?.bytes !== undefined &&
		next.metrics.bytes > previous.metrics.bytes * 1.05
	)
		regressions.push({
			name: previous.name,
			beforeBytes: previous.metrics.bytes,
			afterBytes: next.metrics.bytes,
		});
}
if (
	baseline.memory.historyHeapBytes > 0 &&
	current.memory.historyHeapBytes >
		baseline.memory.historyHeapBytes * 1.25 + 65536
)
	regressions.push({
		name: "memory/history",
		beforeBytes: baseline.memory.historyHeapBytes,
		afterBytes: current.memory.historyHeapBytes,
	});
console.log(
	JSON.stringify(
		{ mode: flags.includes("--strict") ? "blocking" : "advisory", regressions },
		null,
		2,
	),
);
if (regressions.length && flags.includes("--strict")) process.exitCode = 1;
