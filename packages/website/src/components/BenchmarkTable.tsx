import { createMemo, For, Show } from "solid-js";
import {
	formatScore,
	rankScore,
	type ComparisonColumn,
	type ComparisonRow,
} from "~/data/benchmarks";
import styles from "./Benchmarks.module.css";

/** An info button whose bubble is placed in viewport coordinates, so the scrolling table cannot clip it. */
export function Info(props: { text: string }) {
	let bubble!: HTMLSpanElement;
	const place = (event: { currentTarget: HTMLElement }) => {
		const box = event.currentTarget.getBoundingClientRect();
		bubble.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - bubble.offsetWidth - 8))}px`;
		bubble.style.top = `${box.bottom + 8}px`;
	};
	return (
		<button
			type="button"
			class={styles.info}
			aria-label={props.text}
			onMouseEnter={place}
			onFocus={place}
		>
			i
			<span ref={bubble} aria-hidden="true">
				{props.text}
			</span>
		</button>
	);
}

export function BenchmarkTable(props: {
	caption: string;
	unit: string;
	columns: ComparisonColumn[];
	rows: ComparisonRow[];
	direction?: "lower" | "higher";
	/** A caveat about the whole table, shown in an info bubble after the caption. */
	note?: string;
}) {
	// Use the unrounded mean of available results in the currently displayed table.
	const columns = createMemo(() =>
		props.columns
			.map((column) => {
				const values = props.rows
					.map((row) => row.values[column.id]?.value)
					.filter(
						(value): value is number =>
							value !== undefined && Number.isFinite(value),
					);
				return {
					column,
					mean: values.length
						? values.reduce((sum, value) => sum + value, 0) / values.length
						: undefined,
				};
			})
			.sort((a, b) => {
				if (a.mean === undefined) return b.mean === undefined ? 0 : 1;
				if (b.mean === undefined) return -1;
				return props.direction === "higher" ? b.mean - a.mean : a.mean - b.mean;
			})
			.map(({ column }) => column),
	);
	return (
		<div
			class={styles.tableWrap}
			role="region"
			aria-label={props.caption}
			tabindex="0"
		>
			<table class={styles.table}>
				<caption>
					{props.caption}
					<Show when={props.note}>{(note) => <Info text={note()} />}</Show>{" "}
					<span>
						{props.unit} · {props.direction === "higher" ? "higher" : "lower"}{" "}
						is better
					</span>
				</caption>
				<thead>
					<tr>
						<th scope="col">Scenario</th>
						<For each={columns()}>
							{(column) => (
								<th scope="col" data-engine={column.id}>
									{column.label}
									<Show when={column.help}>
										{(help) => <Info text={help()} />}
									</Show>
									<small>{column.detail}</small>
								</th>
							)}
						</For>
					</tr>
				</thead>
				<tbody>
					<For each={props.rows}>
						{(row) => (
							<tr>
								<th scope="row">
									{row.label}
									<Show when={row.help}>
										{(help) => <Info text={help()} />}
									</Show>
									<small>{row.detail}</small>
								</th>
								<For each={columns()}>
									{(column) => {
										const cell = () => row.values[column.id];
										const rank = () =>
											rankScore(
												cell()?.value,
												props.columns.map((col) => row.values[col.id]?.value),
												props.direction,
											);
										return (
											<td
												data-rank={rank()}
												data-failed={cell()?.failed || undefined}
											>
												<Show
													when={cell()?.value !== undefined}
													fallback={
														<span class={styles.missing}>
															—
															<Show when={cell()?.missing}>
																<small>{cell()?.missing}</small>
															</Show>
														</span>
													}
												>
													{formatScore(cell()!.value!)}
													<Show when={cell()?.detail}>
														<small>{cell()?.detail}</small>
													</Show>
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
