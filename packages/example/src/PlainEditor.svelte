<script lang="ts">
	import { EditorView, keymap, lineNumbers } from "@codemirror/view";
	import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
	import { bindCodeMirror } from "pulsify-codemirror";
	import type { Pulse } from "pulsify-core";
	import { me } from "./pulsify";

	let { doc }: { doc: Pulse<any> } = $props();

	function editor(element: HTMLElement) {
		const view = new EditorView({
			parent: element,
			extensions: [
				lineNumbers(),
				history(),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				EditorView.lineWrapping,
			],
		});
		// Edits synchronize through the pulse; the other tabs' cursors are drawn here.
		const binding = bindCodeMirror(view, doc.body, {
			selection: { name: me, color: "#000" },
		});
		return () => {
			binding.destroy();
			view.destroy();
		};
	}
</script>

<div {@attach editor}></div>
