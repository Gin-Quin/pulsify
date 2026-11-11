import { For, Show } from "solid-js";
import { formatScore, rankScore, type ComparisonColumn, type ComparisonRow } from "~/data/benchmarks";
import styles from "./Benchmarks.module.css";

export function BenchmarkLegend() {
	return (
		<div class={styles.legend} aria-label="Score legend">
			<span data-rank="best"><i /> Best</span>
			<span data-rank="worst"><i /> Worst</span>
			<span>Compared within each row · ties share a rank · — unmeasured</span>
		</div>
	);
}

export function BenchmarkTable(props: {
	caption: string;
	unit: string;
	columns: ComparisonColumn[];
	rows: ComparisonRow[];
	direction?: "lower" | "higher";
	format?: (value: number) => string;
}) {
	return (
		<div class={styles.tableWrap} role="region" aria-label={props.caption} tabindex="0">
			<table class={styles.table}>
				<caption>{props.caption} <span>{props.unit} · {props.direction === "higher" ? "Higher" : "Lower"} is better</span></caption>
				<thead>
					<tr>
						<th scope="col">Scenario</th>
						<For each={props.columns}>
							{(column) => <th scope="col" data-engine={column.id}>{column.label}<small>{column.detail}</small></th>}
						</For>
					</tr>
				</thead>
				<tbody>
					<For each={props.rows} fallback={<tr><td colspan={props.columns.length + 1} class={styles.empty}>No matching scenarios. Try another filter.</td></tr>}>
						{(row) => (
							<tr>
								<th scope="row" title={row.description}>{row.label}<small>{row.detail}</small></th>
								<For each={props.columns}>
									{(column) => {
										const cell = () => row.values[column.id];
										const rank = () => rankScore(cell()?.value, props.columns.map(col => row.values[col.id]?.value), props.direction);
										return (
											<td data-rank={rank()} data-failed={cell()?.failed || undefined}>
												<Show when={cell()?.value !== undefined} fallback={<span class={styles.missing} title={cell()?.missing}>—<small>{cell()?.missing ?? "Not measured"}</small></span>}>
													<span class={styles.score}>{(props.format ?? formatScore)(cell()!.value!)}<Show when={rank()}>{(r) => <span class={styles.rank}>{r() === "best" ? "Best" : "Worst"}</span>}</Show></span>
													<Show when={cell()?.detail}><small>{cell()?.detail}</small></Show>
												</Show>
											</td>
										);
									}}
								</For>
							</tr>
						)}
					</For>
				</tbody>
			</table>
		</div>
	);
}
