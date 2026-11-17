import {
	createPulse,
	definePresence,
	definePulse,
	object,
	tree,
	type ModelFromDefinition,
	type Pulse,
	type TreeJSONNode,
} from "pulsify-core";
import { createMutablePulse, createPulsePresence } from "pulsify-solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon } from "~/components/Icon";
import { me, openRoom } from "./room";
import { Room, Shell } from "./Shell";
import styles from "./Board.module.css";

/**
 * The four columns are the roots of a tree and the cards their children: a
 * tree moves nodes, so two people moving the same card at once never
 * duplicate or lose it.
 */
const Kanban = definePulse(
	"DemoBoard",
	object({ cards: tree(object({ title: "string" })) }),
).materialize();
type Kanban = Pulse<ModelFromDefinition<typeof Kanban>>;
type Node = TreeJSONNode<{ title: string }>;

/** The card each person is dragging or renaming. */
const Hand = definePresence(
	"board-hand",
	object({ name: "string", color: "string", card: "string" }),
);

const COLUMNS = ["Backlog", "To do", "In progress", "Done"];
const SAMPLES = [
	"Drag me to another column",
	"Double-click a card to rename it",
	"Invite someone, go offline, move cards on both sides",
];

export default function BoardDemo() {
	return (
		<Room
			open={() =>
				openRoom(Kanban, (id) => {
					const pulse = createPulse(
						Kanban,
						{ id, cards: {} },
						{ connect: true },
					);
					for (const title of COLUMNS) {
						const column = pulse.cards.createNode({ title });
						if (title === COLUMNS[0])
							for (const sample of SAMPLES)
								column.createNode({ title: sample });
					}
					return pulse;
				})
			}
		>
			{(pulse: Kanban) => <Columns pulse={pulse} />}
		</Room>
	);
}

function Columns(props: { pulse: Kanban }) {
	const board = createMutablePulse(props.pulse);
	const columns = createMemo(() => board.cards.toJSON() as Node[]);
	// Rows follow IDs, so that a change elsewhere keeps what is typed in them.
	const ids = (nodes: Node[]) => nodes.map((node) => node.id);
	const hands = createPulsePresence(props.pulse, Hand);
	const node = (id: string) => props.pulse.cards.getNode(id);
	const [editing, setEditing] = createSignal("");
	const hold = (card: string) =>
		hands.set({ name: me.name, color: me.color, card });
	hold("");
	const holder = (card: string) =>
		hands.others.find((other) => other.state.card === card)?.state;

	// ponytail: native drag and drop, which phones barely support; pointer events if the board must work on touch.
	/** The top half of a card drops before it, the bottom half after it. */
	function drop(event: DragEvent, target: string | undefined, column: string) {
		event.preventDefault();
		event.stopPropagation();
		const card = node(event.dataTransfer!.getData("text/plain"));
		const other = target && node(target);
		if (!card || card.id === target) return;
		if (!other) return card.move(node(column));
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		if (event.clientY < box.top + box.height / 2) card.moveBefore(other);
		else card.moveAfter(other);
	}
	function rename(id: string, title: string) {
		setEditing("");
		hold("");
		const card = node(id);
		if (card && title.trim()) card.data.title = title.trim();
	}

	return (
		<Shell
			title="Board"
			icon="columns"
			people={hands.others.map((other) => other.state)}
			pulse={props.pulse}
		>
			<div class={styles.board}>
				<For each={ids(columns())}>
					{(columnId) => {
						const column = () =>
							columns().find((node) => node.id === columnId)!;
						return (
							<section
								class={styles.column}
								onDragOver={(event) => event.preventDefault()}
								onDrop={(event) => drop(event, undefined, columnId)}
							>
								<h2>
									{column().data.title}
									<span>{column().children.length}</span>
								</h2>
								<For each={ids(column().children)}>
									{(id) => {
										const card = {
											id,
											get title() {
												return (
													column().children.find((node) => node.id === id)?.data
														.title ?? ""
												);
											},
										};
										return (
											<article
												class={styles.card}
												draggable={editing() !== card.id}
												style={
													holder(card.id)
														? { "--holder": holder(card.id)!.color }
														: undefined
												}
												data-held={holder(card.id) ? "" : undefined}
												onDragStart={(event) => {
													event.dataTransfer!.setData("text/plain", card.id);
													hold(card.id);
												}}
												onDragEnd={() => hold("")}
												onDragOver={(event) => event.preventDefault()}
												onDrop={(event) => drop(event, card.id, columnId)}
												onDblClick={() => {
													setEditing(card.id);
													hold(card.id);
												}}
											>
												<Show
													when={editing() === card.id}
													fallback={<p>{card.title}</p>}
												>
													<textarea
														ref={(input) =>
															queueMicrotask(() => input.select())
														}
														value={card.title}
														onBlur={(event) =>
															rename(card.id, event.currentTarget.value)
														}
														onKeyDown={(event) => {
															if (event.key === "Enter" && !event.shiftKey) {
																event.preventDefault();
																event.currentTarget.blur();
															}
														}}
													/>
												</Show>
												<Show when={holder(card.id)}>
													{(person) => (
														<span class={styles.holder}>{person().name}</span>
													)}
												</Show>
												<button
													type="button"
													class={styles.delete}
													aria-label="Delete the card"
													onClick={() => node(card.id)?.delete()}
												>
													<Icon name="cross" size="0.9rem" />
												</button>
											</article>
										);
									}}
								</For>
								<input
									class={styles.add}
									placeholder="+ Add a card"
									onKeyDown={(event) => {
										const title = event.currentTarget.value.trim();
										if (event.key !== "Enter" || !title) return;
										node(columnId)?.createNode({ title });
										event.currentTarget.value = "";
									}}
								/>
							</section>
						);
					}}
				</For>
			</div>
		</Shell>
	);
}
