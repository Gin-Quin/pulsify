import type { JSX } from "solid-js";
import { CodeBlock } from "./CodeBlock";
import { Note } from "./DocsLayout";

/** Shared section of the frontend pages: pulses never exist on the server. */
export function NeverOnTheServer(props: {
	/** File name of the example that must never be written. */
	file: string;
	code: string;
	/** What to do instead in this framework. */
	children: JSX.Element;
}) {
	return (
		<>
			<h2>Never on the server</h2>
			<Note kind="danger">
				<strong>Dangerous.</strong> Never call <code>loadPulse</code> or{" "}
				<code>createPulse</code> in code that runs on the server. It works,
				which is the problem: nothing fails until one user receives the document
				of another.
			</Note>
			<CodeBlock title={`✗ Never do this · ${props.file}`} code={props.code} />
			<ul>
				<li>
					<strong>It leaks documents between users.</strong> A loaded pulse
					stays in a scope shared by the whole server process, and{" "}
					<code>loadPulse</code> returns it to the next request for that ID
					without asking the relay, so without any authorization check.
				</li>
				<li>
					<strong>It leaks connections and memory.</strong> A pulse stays loaded
					and connected until <code>destroyPulse</code>: every request leaves a
					socket and a document behind until the server stops.
				</li>
				<li>
					<strong>It gains nothing.</strong> The HTML holds a snapshot that is
					out of date as soon as it is sent, and the browser has to load the
					pulse again to edit it.
				</li>
			</ul>
			<p>A server relays patches and never reads a pulse. {props.children}</p>
		</>
	);
}

const defaults = `import { createWebSocketConnector, setDefaultPulseOptions } from "pulsify-core";
import { createIndexedDbConnector } from "pulsify-indexeddb";

// Once, in the browser, before the first pulse is created or loaded.
setDefaultPulseOptions({
  connectors: [
    createIndexedDbConnector({ name: "my-app" }),
    createWebSocketConnector("wss://example.com/sync?doc={docId}"),
  ],
  connect: true, // createPulse starts synchronizing at once
});`;

/** Shared section of the frontend pages: connectors are set once. */
export function DefaultConnectors(props: { file: string }) {
	return (
		<>
			<h2>Set the connectors once</h2>
			<p>
				Every pulse created or loaded afterwards uses these connectors, so the
				examples below pass none. Pass <code>connectors</code> to{" "}
				<code>createPulse</code> or <code>loadPulse</code> only for a pulse that
				syncs elsewhere.
			</p>
			<CodeBlock title={props.file} code={defaults} />
		</>
	);
}
