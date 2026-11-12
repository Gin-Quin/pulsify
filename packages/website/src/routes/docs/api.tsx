import { Title } from "@solidjs/meta";
import { For } from "solid-js";
import { GITHUB_URL } from "~/components/links";

const groups: { title: string; items: [string, string][] }[] = [
	{
		title: "Define",
		items: [
			[
				"definePulse(kind, schema, options?)",
				"Start a definition. Options: richTextPaths (constantPaths is deprecated).",
			],
			[
				".migrateTo(schema, fn, options?)",
				"Append a schema version with its transformation.",
			],
			[
				".materialize<T>(fn?)",
				"Finish the definition. fn receives { bind } and returns bindings.",
			],
			["richText()", "Collaborative text field marker inside a schema."],
			[
				"constant(schema)",
				"Value fixed at creation: never replaced or edited.",
			],
			[
				"frozen(schema)",
				"Value replaced only as a whole; its contents are readonly.",
			],
			["tree(schema)", "Ordered movable tree of typed payloads."],
		],
	},
	{
		title: "Use",
		items: [
			[
				"createPulse(Def, data, options?)",
				"New document. options: id, connectors, connect, scope, onError.",
			],
			[
				"loadPulse(Def, id, options?)",
				"Existing document. options: connectors, waitFor, timeoutMs, signal.",
			],
			[
				"subscribePulse(pulse, fn)",
				"Called now and after each commit. Returns unsubscribe.",
			],
			["snapshotPulse(pulse)", "Detached plain copy, materialized."],
			["arrayOperations(arr)", "insert, delete, move, replaceAll."],
			["destroyPulse(pulse)", "Close sessions and release the instance."],
		],
	},
	{
		title: "Connect",
		items: [
			["connectPulse(pulse)", "Returns { ready, connected, synced }."],
			["disconnectPulse(pulse)", "Close transports, keep editing."],
			[
				"createWebSocketConnector(url, factory?, { protocolVersion })",
				"Remote connector.",
			],
			[
				"createMemoryConnector(relay?, kind?)",
				"Local connector over an in-process relay.",
			],
			[
				"createPulseScope()",
				"Isolated identity map, one instance per document ID.",
			],
			["getPulseMeta(pulse)", "Status and last connection error."],
			["setDefaultPulseOptions(options)", "Process-wide defaults."],
		],
	},
	{
		title: "Presence",
		items: [
			[
				"definePresence(name, schema, { throttleMs })",
				"A typed channel of live state that is shared and never stored.",
			],
			[
				"joinPresence(pulse, Channel)",
				"Returns { others, mine, set, subscribe, leave } for that pulse.",
			],
			[
				"RichTextSelection",
				"The channel of text selections that the editor bindings share: { anchor, head, name, color }.",
			],
			[
				"field.anchorAt(index) / field.indexOf(anchor)",
				"A position in a richText() field as a string that survives every edit.",
			],
			[
				"createWebSocketConnector(url, factory?, { presence: true })",
				"Opt in for a relay running version 10 or later. Pulsify Cloud needs nothing.",
			],
		],
	},
	{
		title: "Server",
		items: [
			[
				"new PulseRelay()",
				"In-memory relay; open(send, { protocolVersion, subject }) returns a peer.",
			],
			[
				"PostgresPatchStore / SqlitePatchStore",
				"pulsify-core/storage: initialize, appendEncoded, missing, vector.",
			],
			[
				"PatchStore",
				"The interface to implement for any other database: append, appendEncoded, vector, missing.",
			],
			[
				"relayStoreMessage(store, bytes, session)",
				"pulsify-core/protocol: serve one frame from a store. Returns responses, broadcast and presence to forward.",
			],
			[
				"encodePresenceLeave(docId, peer)",
				"pulsify-core/protocol: the frame to send the others when a session ends.",
			],
			[
				"exportPulseUpdates / applyPulseUpdates",
				"Manual frame exchange between two pulses.",
			],
		],
	},
	{
		title: "Errors",
		items: [
			["PulseError", "code: NOT_FOUND, CLOSED, TIMEOUT, LIMIT_EXCEEDED, …"],
			[
				"MigrationDriftError",
				"code MIGRATION_DRIFT; incompatible schema chain, nothing written.",
			],
		],
	},
];

export default function Api() {
	return (
		<>
			<Title>API cheat sheet · Docs</Title>
			<h1>API cheat sheet</h1>
			<p>
				Everything exported from <code>pulsify-core</code> that you will use day
				to day. The{" "}
				<a href={`${GITHUB_URL}/blob/main/packages/pulse/README.md`}>
					package README
				</a>{" "}
				documents the rest, and the{" "}
				<a href={`${GITHUB_URL}/blob/main/docs/PROTOCOL.md`}>protocol spec</a>{" "}
				covers the wire format.
			</p>
			<For each={groups}>
				{(group) => (
					<>
						<h2>{group.title}</h2>
						<table>
							<tbody>
								<For each={group.items}>
									{([signature, text]) => (
										<tr>
											<th scope="row">
												<code>{signature}</code>
											</th>
											<td>{text}</td>
										</tr>
									)}
								</For>
							</tbody>
						</table>
					</>
				)}
			</For>
		</>
	);
}
