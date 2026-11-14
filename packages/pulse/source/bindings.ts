/** Low-level, editor-independent adapter API. Never bundle a second core copy. */
export {
	RT_PREFIX,
	RT_NODE,
	RT_PARENT,
	RT_TYPE,
	RT_ATTR,
	RT_MARK,
	RT_FORMAT,
	RT_REDIRECT,
	RT_REMOVED,
	RT_TEXTBLOCK,
	isRichTextNode,
	newerTextStamp,
	richTextContext,
	richTextRedirects,
	richTextRemovedNodes,
	resolveRichTextAnchor,
	type RichTextContext,
} from "./core/richTextBinding.js";
export { plainTextContext, type PlainTextContext } from "./core/plainText.js";
export {
	editorAttributes,
	reconcileEditorTokens,
	matchTokens,
	commitEditorOperations,
	invertEditorChange,
	type EditorToken,
	type EditorChange,
} from "./core/editorTokens.js";
export type { CoreEntry, Stamp } from "./core/model.js";
export type { CoreOperation } from "./core/operations.js";
export { fingerprintBytes } from "./utilities/fingerprint.js";
export { RichTextSymbol, PulseRefSymbol } from "./core/values.js";
export { TreeSymbol } from "./core/treeSchema.js";
export { createPulseViews } from "./utilities/pulseViews.js";
export { defaultPulseOptions } from "./pulses/PulseOptions.js";

export {
	createPulsifyHistory,
	connectEditorHistory,
	type PulsifyHistory,
	type PulsifyHistoryOptions,
} from "./core/editorHistory.js";
export { heldSelections } from "./presence/heldSelections.js";
