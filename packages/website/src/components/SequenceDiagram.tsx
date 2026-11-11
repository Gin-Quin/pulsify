import { For } from "solid-js";
import styles from "./SequenceDiagram.module.css";

/** One arrow between two actors (by index), or a note on one lifeline when `from === to`. */
export type SequenceStep = {
	from: number;
	to: number;
	label: string;
	reply?: boolean;
};

const COLUMN = 210;
const ROW = 44;
const TOP = 60;

/** Minimal SVG sequence diagram for the docs. */
export function SequenceDiagram(props: {
	actors: string[];
	steps: SequenceStep[];
	caption: string;
}) {
	const x = (actor: number) => COLUMN / 2 + actor * COLUMN;
	const y = (step: number) => TOP + step * ROW + ROW / 2;
	const width = () => props.actors.length * COLUMN;
	const height = () => TOP + props.steps.length * ROW + 12;
	return (
		<figure class={styles.figure}>
			<svg
				class={styles.svg}
				viewBox={`0 0 ${width()} ${height()}`}
				role="img"
				aria-label={props.caption}
			>
				<defs>
					<marker
						id="sequence-arrow"
						viewBox="0 0 10 10"
						refX="9"
						refY="5"
						markerWidth="7"
						markerHeight="7"
						orient="auto-start-reverse"
					>
						<path d="M0 0L10 5L0 10z" class={styles.head} />
					</marker>
				</defs>
				<For each={props.actors}>
					{(actor, i) => (
						<g>
							<line
								class={styles.lifeline}
								x1={x(i())}
								x2={x(i())}
								y1={44}
								y2={height() - 4}
							/>
							<rect
								class={styles.actor}
								x={x(i()) - 88}
								y={8}
								width={176}
								height={36}
								rx={8}
							/>
							<text class={styles.actorLabel} x={x(i())} y={31}>
								{actor}
							</text>
						</g>
					)}
				</For>
				<For each={props.steps}>
					{(step, i) =>
						step.from === step.to ? (
							<g>
								<rect
									class={styles.note}
									x={x(step.from) - 96}
									y={y(i()) - 15}
									width={192}
									height={26}
									rx={6}
								/>
								<text class={styles.noteLabel} x={x(step.from)} y={y(i()) + 3}>
									{step.label}
								</text>
							</g>
						) : (
							<g>
								<line
									class={step.reply ? styles.reply : styles.call}
									x1={x(step.from)}
									x2={x(step.to) + (step.to > step.from ? -3 : 3)}
									y1={y(i()) + 6}
									y2={y(i()) + 6}
									marker-end="url(#sequence-arrow)"
								/>
								<text
									class={styles.label}
									x={(x(step.from) + x(step.to)) / 2}
									y={y(i())}
								>
									{step.label}
								</text>
							</g>
						)
					}
				</For>
			</svg>
			<figcaption class={styles.caption}>{props.caption}</figcaption>
		</figure>
	);
}
