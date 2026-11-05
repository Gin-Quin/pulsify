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
	type RichTextContext,
} from "./core/richTextBinding.js";
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
