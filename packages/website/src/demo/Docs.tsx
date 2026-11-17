import "prosemirror-view/style/prosemirror.css";
import {
	baseKeymap,
	setBlockType,
	toggleMark,
	wrapIn,
} from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { Schema, type MarkType, type NodeType } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import {
	addListNodes,
	liftListItem,
	sinkListItem,
	splitListItem,
	wrapInList,
} from "prosemirror-schema-list";
import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
	createPulse,
	definePresence,
	definePulse,
	object,
	record,
	richText,
	type ModelFromDefinition,
	type Pulse,
} from "pulsify-core";
import { bindProseMirror, redo, undo } from "pulsify-prosemirror";
import { createMutablePulse, createPulsePresence } from "pulsify-solid";
import {
	createEffect,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { Icon, type IconName } from "~/components/Icon";
import { me, openRoom } from "./room";
import { Room, Shell } from "./Shell";
import styles from "./Docs.module.css";

const Docs = definePulse(
	"DemoDocs",
	object({
		files: record(
			object({ title: "string", created: "float64", body: richText() }),
		),
	}),
).materialize();
type Docs = Pulse<ModelFromDefinition<typeof Docs>>;

/** Who is here, and which document they have open. */
const Reader = definePresence(
	"docs-reader",
	object({ name: "string", color: "string", file: "string" }),
);

const WELCOME =
	"Invite someone with the button at the top right and write here together: you will see each other's cursor. Then switch offline, keep typing on both sides, and switch back online: the two versions merge.";

const newId = () => crypto.randomUUID().slice(0, 8);

export default function DocsDemo() {
	return (
		<Room
			open={() =>
				openRoom(Docs, (id) =>
					createPulse(
						Docs,
						{
							id,
							files: {
								[newId()]: {
									title: "Welcome",
									created: Date.now(),
									body: WELCOME,
								},
							},
						},
						{ connect: true },
					),
				)
			}
		>
			{(pulse: Docs) => <Files pulse={pulse} />}
		</Room>
	);
}

function Files(props: { pulse: Docs }) {
	const docs = createMutablePulse(props.pulse);
	const readers = createPulsePresence(props.pulse, Reader);
	const ids = () =>
		Object.keys(docs.files).sort(
			(a, b) => docs.files[a]!.created - docs.files[b]!.created,
		);
	const [selected, setSelected] = createSignal<string>();
	// The open document, or the first one once it is deleted.
	const current = () => {
		const id = selected();
		return id && docs.files[id] ? id : ids()[0];
	};
	createEffect(() =>
		readers.set({ name: me.name, color: me.color, file: current() ?? "" }),
	);

	function create() {
		const id = newId();
		docs.files[id] = { title: "", created: Date.now(), body: "" } as never;
		setSelected(id);
	}
	function remove(id: string) {
		if (confirm(`Delete “${docs.files[id]?.title || "Untitled document"}”?`))
			delete docs.files[id];
	}

	return (
		<Shell
			title="Docs"
			icon="file"
			people={readers.others.map((other) => other.state)}
			pulse={props.pulse}
		>
			<div class={styles.layout}>
				<aside class={styles.files}>
					<button class={styles.new} type="button" onClick={create}>
						<Icon name="plus" size="1.1em" />
						New document
					</button>
					<For each={ids()}>
						{(id) => (
							<div
								class={styles.file}
								role="button"
								tabIndex={0}
								aria-current={id === current() ? "page" : undefined}
								onClick={() => setSelected(id)}
								onKeyDown={(event) => event.key === "Enter" && setSelected(id)}
							>
								<Icon name="file" size="1.1em" />
								<span class={styles.name}>
									{docs.files[id]?.title || "Untitled document"}
								</span>
								<For
									each={readers.others.filter(
										(other) => other.state.file === id,
									)}
								>
									{(other) => (
										<i
											class={styles.dot}
											style={{ "background-color": other.state.color }}
											title={other.state.name}
										/>
									)}
								</For>
								<button
									class={styles.delete}
									type="button"
									aria-label="Delete"
									onClick={(event) => {
										event.stopPropagation();
										remove(id);
									}}
								>
									<Icon name="trash" size="1em" />
								</button>
							</div>
						)}
					</For>
				</aside>
				<section class={styles.desk}>
					<Show
						when={current()}
						keyed
						fallback={<p class={styles.empty}>No document: create one.</p>}
					>
						{(id) => <Page pulse={props.pulse} id={id} />}
					</Show>
				</section>
			</div>
		</Shell>
	);
}

const schema = new Schema({
	nodes: addListNodes(basic.spec.nodes, "paragraph block*", "block"),
	marks: basic.spec.marks,
});
const { strong, em } = schema.marks as Record<string, MarkType>;
const { paragraph, heading, blockquote, bullet_list, ordered_list, list_item } =
	schema.nodes as Record<string, NodeType>;

/** A mark is active on the selection, or for what is typed next. */
function hasMark(state: EditorState, mark: MarkType) {
	const { from, to, empty, $from } = state.selection;
	return empty
		? !!mark.isInSet(state.storedMarks ?? $from.marks())
		: state.doc.rangeHasMark(from, to, mark);
}

const tools: {
	label: string;
	text: string | IconName;
	command: Command;
	mark?: MarkType;
}[] = [
	{ label: "Undo", text: "undo", command: undo },
	{ label: "Redo", text: "redo", command: redo },
	{ label: "Bold", text: "B", command: toggleMark(strong!), mark: strong },
	{ label: "Italic", text: "I", command: toggleMark(em!), mark: em },
	{ label: "Text", text: "¶", command: setBlockType(paragraph!) },
	{
		label: "Heading 1",
		text: "H1",
		command: setBlockType(heading!, { level: 1 }),
	},
	{
		label: "Heading 2",
		text: "H2",
		command: setBlockType(heading!, { level: 2 }),
	},
	{ label: "Bulleted list", text: "•", command: wrapInList(bullet_list!) },
	{ label: "Numbered list", text: "1.", command: wrapInList(ordered_list!) },
	{ label: "Quote", text: "“", command: wrapIn(blockquote!) },
];

function Page(props: { pulse: Docs; id: string }) {
	const docs = createMutablePulse(props.pulse);
	let mount!: HTMLDivElement;
	let title!: HTMLInputElement;
	const [view, setView] = createSignal<EditorView>();
	// Bumped by every transaction, to redraw the toolbar.
	const [state, setState] = createSignal<EditorState>();

	onMount(() => {
		const editor: EditorView = new EditorView(mount, {
			state: EditorState.create({
				schema,
				plugins: [
					keymap({
						"Mod-z": undo,
						"Mod-Shift-z": redo,
						"Mod-y": redo,
						"Mod-b": toggleMark(strong!),
						"Mod-i": toggleMark(em!),
						Enter: splitListItem(list_item!),
						Tab: sinkListItem(list_item!),
						"Shift-Tab": liftListItem(list_item!),
					}),
					keymap(baseKeymap),
				],
			}),
			dispatchTransaction(transaction) {
				editor.updateState(editor.state.apply(transaction));
				setState(editor.state);
			},
		});
		// Edits synchronize through the pulse; the others' cursors are drawn here.
		const binding = bindProseMirror(editor, props.pulse.files[props.id]!.body, {
			selection: { name: me.name, color: me.color },
		});
		setView(editor);
		setState(editor.state);
		// A new document starts with its title.
		if (!docs.files[props.id]?.title) title.focus();
		onCleanup(() => {
			binding.destroy();
			editor.destroy();
		});
	});
	function run(command: Command) {
		const editor = view();
		if (!editor) return;
		command(editor.state, editor.dispatch);
		editor.focus();
	}

	return (
		<div class={styles.page}>
			<div class={styles.toolbar}>
				<For each={tools}>
					{(tool) => (
						<button
							type="button"
							title={tool.label}
							aria-label={tool.label}
							aria-pressed={
								tool.mark
									? !!state() && hasMark(state()!, tool.mark)
									: undefined
							}
							disabled={!state() || !tool.command(state()!)}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => run(tool.command)}
						>
							{tool.text === "undo" || tool.text === "redo" ? (
								<Icon name={tool.text} size="1.1em" />
							) : (
								tool.text
							)}
						</button>
					)}
				</For>
			</div>
			<div class={styles.paper}>
				<input
					class={styles.title}
					placeholder="Untitled document"
					ref={title}
					value={docs.files[props.id]?.title ?? ""}
					onInput={(event) => {
						const file = docs.files[props.id];
						if (file) file.title = event.currentTarget.value;
					}}
				/>
				<div ref={mount} class={styles.editor} />
			</div>
		</div>
	);
}
