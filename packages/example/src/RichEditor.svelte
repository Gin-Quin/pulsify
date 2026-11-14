<script lang="ts">
	import { Schema, type MarkType, type NodeType } from "prosemirror-model";
	import { EditorState, type Command } from "prosemirror-state";
	import { EditorView } from "prosemirror-view";
	import { schema as basic } from "prosemirror-schema-basic";
	import {
		addListNodes,
		liftListItem,
		sinkListItem,
		splitListItem,
		wrapInList,
	} from "prosemirror-schema-list";
	import {
		baseKeymap,
		lift,
		setBlockType,
		toggleMark,
		wrapIn,
	} from "prosemirror-commands";
	import { keymap } from "prosemirror-keymap";
	import { untrack } from "svelte";
	import { bindProseMirror, redo, undo } from "pulsify-prosemirror";
	import type { Pulse } from "pulsify-core";
	import { me } from "./pulsify";

	let { doc }: { doc: Pulse<any> } = $props();

	const schema = new Schema({
		nodes: addListNodes(basic.spec.nodes, "paragraph block*", "block"),
		marks: basic.spec.marks,
	});
	const { strong, em, code, link } = schema.marks as Record<string, MarkType>;
	const {
		paragraph,
		heading,
		blockquote,
		bullet_list,
		ordered_list,
		list_item,
	} = schema.nodes as Record<string, NodeType>;

	function toggleLink(): Command {
		return (state, dispatch) => {
			const { from, to, empty } = state.selection;
			if (empty) return false;
			if (state.doc.rangeHasMark(from, to, link))
				return toggleMark(link)(state, dispatch);
			const href = dispatch && prompt("Adresse du lien :", "https://");
			if (dispatch && !href) return false;
			return toggleMark(link, { href })(state, dispatch);
		};
	}
	const buttons: [string, Command][] = [
		["Gras", toggleMark(strong)],
		["Italique", toggleMark(em)],
		["Code", toggleMark(code)],
		["Lien", toggleLink()],
		["Paragraphe", setBlockType(paragraph)],
		["Titre 1", setBlockType(heading, { level: 1 })],
		["Titre 2", setBlockType(heading, { level: 2 })],
		["Titre 3", setBlockType(heading, { level: 3 })],
		["Liste", wrapInList(bullet_list)],
		["Liste numérotée", wrapInList(ordered_list)],
		["Citation", wrapIn(blockquote)],
		[
			"Désindenter",
			(state, dispatch) =>
				liftListItem(list_item)(state, dispatch) || lift(state, dispatch),
		],
		["Annuler", undo],
		["Rétablir", redo],
	];

	let view = $state.raw<EditorView>();
	// Redraw the toolbar's states after every transaction.
	let tick = $state(0);
	function run(command: Command) {
		command(view!.state, view!.dispatch);
		view!.focus();
	}

	function editor(element: HTMLElement) {
		const editorView = new EditorView(element, {
			state: EditorState.create({
				schema,
				plugins: [
					keymap({
						"Mod-z": undo,
						"Mod-Shift-z": redo,
						"Mod-y": redo,
						"Mod-b": toggleMark(strong),
						"Mod-i": toggleMark(em),
						"Mod-`": toggleMark(code),
						Enter: splitListItem(list_item),
						Tab: sinkListItem(list_item),
						"Shift-Tab": liftListItem(list_item),
					}),
					keymap(baseKeymap),
				],
			}),
			dispatchTransaction(transaction) {
				editorView.updateState(editorView.state.apply(transaction));
				tick++;
			},
		});
		// Edits synchronize through the pulse; the other tabs' cursors are drawn here.
		const binding = bindProseMirror(editorView, doc.body, {
			selection: { name: me, color: "#000" },
		});
		view = editorView;
		return () => {
			binding.destroy();
			editorView.destroy();
		};
	}
	const enabled = (command: Command) => {
		void tick; // Read so that the toolbar updates after every transaction.
		return view ? command(view.state) : false;
	};
</script>

<div class="toolbar" style="border: 1px solid #000; border-bottom: 0">
	{#each buttons as [label, command] (label)}
		<button
			disabled={!enabled(command)}
			onmousedown={(event) => event.preventDefault()}
			onclick={() => run(command)}>{label}</button
		>
	{/each}
</div>
<!-- untrack: binding dispatches synchronously, and tick++ would make the attachment depend on tick and loop. -->
<div {@attach (element) => untrack(() => editor(element))}></div>
