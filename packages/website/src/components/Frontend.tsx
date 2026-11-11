import { CodeBlock } from "./CodeBlock";
import { Note } from "./DocsLayout";

const note = `import {
  array, createWebSocketConnector, definePulse, object,
  type ModelFromDefinition, type Pulse,
} from "pulsify-core";

export const Note = definePulse("Note", object({
  title: "string",
  tags: array("string"),
  author: object({ name: "string" }),
})).materialize();
export type NotePulse = Pulse<ModelFromDefinition<typeof Note>>;

export const remote = createWebSocketConnector("wss://sync.example.com/sync");`;

/** The definition every frontend page builds on. */
export function NoteDefinition() {
	return <CodeBlock title="note.ts" code={note} />;
}

/** Shared warning: pulses never exist on the server. */
export function ClientOnly(props: { how: string }) {
	return (
		<Note kind="warn">
			Create and load pulses on the client only. A server relays patches; it
			has no local database to load a pulse from, so never call{" "}
			<code>createPulse</code> or <code>loadPulse</code> during server
			rendering. {props.how}
		</Note>
	);
}
