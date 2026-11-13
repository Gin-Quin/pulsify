import {
	Annotation,
	Compartment,
	StateEffect,
	Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type PlainText } from "pulsify-core";
import { plainTextContext } from "pulsify-core/bindings";

export interface CodeMirrorBinding {
	/** Detach the editor from the field; the editor keeps its document. */
	destroy(): void;
}

const remote = Annotation.define<boolean>();

/**
 * Bind an existing CodeMirror view to a `plainText()` field. The field
 * supplies the document; editor changes edit the field, and changes from
 * other peers reach the editor outside its undo history.
 */
export function bindCodeMirror(
	view: EditorView,
	field: PlainText,
): CodeMirrorBinding {
	const { subscribe } = plainTextContext(field);
	// Set while this binding edits the field, so it does not answer itself.
	let writing = false;
	const write = (edit: () => void) => {
		writing = true;
		try {
			edit();
		} finally {
			writing = false;
		}
	};
	// ponytail: compares whole documents on every pulse change, O(length); apply the field's own deltas if large files need it.
	const pull = () => {
		if (writing) return;
		// CodeMirror counts every line break as one "\n": keep the field in that form.
		write(() => {
			for (let i; (i = field.text.indexOf("\r")) >= 0;)
				field.replace(i, 1, field.text[i + 1] === "\n" ? "" : "\n");
		});
		const next = field.text,
			current = view.state.doc.toString();
		if (next === current) return;
		// One change over the differing middle: selections map through it.
		const limit = Math.min(next.length, current.length);
		let start = 0;
		while (start < limit && next[start] === current[start]) start++;
		let tail = 0;
		while (
			tail < limit - start &&
			next[next.length - 1 - tail] === current[current.length - 1 - tail]
		)
			tail++;
		view.dispatch({
			changes: {
				from: start,
				to: current.length - tail,
				insert: next.slice(start, next.length - tail),
			},
			annotations: [remote.of(true), Transaction.addToHistory.of(false)],
		});
	};
	const listener = new Compartment();
	view.dispatch({
		effects: StateEffect.appendConfig.of(
			listener.of(
				EditorView.updateListener.of((update) => {
					if (
						!update.docChanged ||
						update.transactions.some((transaction) =>
							transaction.annotation(remote),
						)
					)
						return;
					// `fromB` is where a change starts once the earlier ones are applied.
					write(() =>
						update.changes.iterChanges((fromA, toA, fromB, _toB, inserted) =>
							field.replace(fromB, toA - fromA, inserted.toString()),
						),
					);
				}),
			),
		),
	});
	pull();
	const unsubscribe = subscribe(pull);
	return {
		destroy() {
			unsubscribe();
			view.dispatch({ effects: listener.reconfigure([]) });
		},
	};
}
