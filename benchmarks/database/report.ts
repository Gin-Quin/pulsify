import type { Profile } from "./fixtures.js";

export type Measurement = {
	backend: string;
	profile: Profile;
	scenario: string;
	warmupMs: number[];
	samplesMs: number[];
	medianMs: number;
	p95Ms: number;
	details: Record<string, unknown>;
	detailsSamples: Record<string, unknown>[];
};
export function statistics(values: number[]) {
	if (!values.length) throw new Error("No measurement samples");
	const sorted = values.toSorted((a, b) => a - b),
		middle = Math.floor(sorted.length / 2);
	return {
		medianMs:
			sorted.length % 2
				? sorted[middle]!
				: (sorted[middle - 1]! + sorted[middle]!) / 2,
		p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
	};
}
export type Report = {
	formatVersion: 1;
	environment: Record<string, unknown>;
	parameters: Record<string, unknown>;
	backends: Record<string, Record<string, unknown>>;
	measurements: Measurement[];
};
export function markdown(report: Report): string {
	return (
		`# Pulsify database benchmark\n\n` +
		`Real Pulsify history; sequential durable transactions, warm local reads. Times include the adapter and its transport.\n\n` +
		`Legacy sequential Bun suite for PostgreSQL and SQLite. SQLite is embedded in the Docker runner. These numbers do not establish an engine ranking.\n\n` +
		`Environment and configuration: see the accompanying JSON, including raw warmup and measured samples.\n\n` +
		`| Database | Profile | Scenario | Median ms | p95 ms | Details (last sample) |\n| --- | --- | --- | ---: | ---: | --- |\n` +
		report.measurements
			.map(
				(m) =>
					`| ${m.backend} | ${m.profile} | ${m.scenario} | ${m.medianMs.toFixed(3)} | ${m.p95Ms.toFixed(3)} | ${JSON.stringify(m.details)} |`,
			)
			.join("\n") +
		"\n"
	);
}
