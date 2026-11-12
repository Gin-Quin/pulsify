import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";

const define = `import { definePresence, object } from "pulsify-core";

// Who has the project open. Set once.
export const Viewer = definePresence("viewer", object({
  name: "string",
  color: "string",
}));

// Where their pointer is. Sent at most every 30 ms (50 by default).
export const Cursor = definePresence("cursor", object({
  x: "float32",
  y: "float32",
}), { throttleMs: 30 });`;

const join = `import { joinPresence } from "pulsify-core";
import { Viewer } from "./presence";

const viewers = joinPresence(project, Viewer);

// Sent now, and again by itself after every reconnection.
viewers.set({ name: "Ada", color: "#e5484d" });

viewers.mine;   // { name: "Ada", color: "#e5484d" }
viewers.others; // [{ peer: 7, state: { name: "Grace", color: "#30a46c" } }, …]

// Called now, then after every change of \`others\` or \`mine\`.
const stop = viewers.subscribe(({ others }) => {
  avatars.replaceChildren(...others.map(({ state }) => avatar(state)));
});`;

const several = `import { Cursor, Viewer } from "./presence";

const viewers = joinPresence(project, Viewer);
const cursors = joinPresence(project, Cursor);

// Call it as often as you like: the channel sends the latest state, throttled.
board.addEventListener("pointermove", (event) => {
  cursors.set({ x: event.offsetX, y: event.offsetY });
});
// I have no cursor any more; I still see theirs.
board.addEventListener("pointerleave", () => cursors.set(undefined));

cursors.subscribe(({ others }) => {
  for (const { peer, state } of others) {
    // The same peer number in every channel of the pulse.
    const viewer = viewers.others.find((viewer) => viewer.peer === peer);
    draw(peer, state.x, state.y, viewer?.state.color);
  }
});`;

const leave = `cursors.leave();       // stop listening; my cursor disappears for everyone
destroyPulse(project); // leaves every channel of the pulse`;

const contract = `type Presence<State> = {
  /** Everyone else in the channel. A new array only when something changed. */
  readonly others: readonly PresencePeer<State>[];
  /** What I last set, or undefined. */
  readonly mine: State | undefined;
  /** Publish my state; undefined removes it. */
  set(state: State | undefined): void;
  /** Called now, then synchronously after every change, and once when this holder leaves. */
  subscribe(listener: (presence: Presence<State>) => void): () => void;
  /** Undo this joinPresence. The channel closes with its last holder. */
  leave(): void;
};

type PresencePeer<State> = {
  /** One connected session: a tab, a window, a device. Given by the relay. */
  readonly peer: number;
  /** Who the relay authenticated, when it did. */
  readonly subject?: string;
  readonly state: State;
};`;

const optIn = `import { createWebSocketConnector } from "pulsify-core";

// The server runs pulsify-core 9 or later.
const relay = createWebSocketConnector(url, undefined, { presence: true });`;

const anchors = `const caret = note.body.anchorAt(5); // a string that follows the character before index 5

note.body.insert(0, "Hey ");           // someone types before it
note.body.indexOf(caret);              // 9`;

const memoryRelay = `// The relay of "Self-hosting", unchanged. \`subject\` is optional: it names
// the user you authenticated, and every peer reads it as \`peer.subject\`.
socket.data.peer = relay.open((bytes) => socket.sendBinary(bytes), {
  docId,
  readOnly,
  subject: user.id,
});`;

const storeRelay = `import type { ServerWebSocket } from "bun";
import { encodeBroadcast, encodePresenceLeave, relayStoreMessage } from "pulsify-core/protocol";

// presence: a peer number, who it is, and whether this client uses presence
type Session = { docId: string; readOnly: boolean; peer: number; subject: string; presence?: boolean };
const rooms = new Map<string, Set<ServerWebSocket<Session>>>();
let peers = 0;

Bun.serve<Session>({
  async fetch(request, server) {
    // …your authentication, then:
    const data = { docId, readOnly: role !== "editor", peer: ++peers, subject: user.id };
    return server.upgrade(request, { data }) ? undefined : new Response(null, { status: 400 });
  },
  websocket: {
    open(socket) {
      const room = rooms.get(socket.data.docId) ?? new Set();
      rooms.set(socket.data.docId, room.add(socket));
    },
    async message(socket, message) {
      if (typeof message === "string") return socket.close(1003);
      const { docId } = socket.data;
      const result = await relayStoreMessage(store, new Uint8Array(message), socket.data);
      for (const frame of result.responses) socket.sendBinary(frame);
      const update = result.broadcast && encodeBroadcast(docId, result.broadcast);
      const { presence } = result;
      if (presence) socket.data.presence = true;
      for (const other of rooms.get(docId) ?? []) {
        if (other === socket) continue;
        if (update) other.sendBinary(update);
        // presence: to the others that use it, or to the one peer this frame answers
        if (presence && other.data.presence && (!presence.to || presence.to === other.data.peer))
          other.sendBinary(presence.frame);
      }
    },
    close(socket) {
      const { docId, peer } = socket.data;
      const room = rooms.get(docId);
      room?.delete(socket);
      // presence: tell the others this peer is gone
      for (const other of room ?? [])
        if (other.data.presence) other.sendBinary(encodePresenceLeave(docId, peer));
    },
  },
});`;

export default function Presence() {
	return (
		<>
			<Title>Presence · Docs</Title>
			<h1>Presence</h1>
			<p>
				Presence is live state that is <strong>shared but never stored</strong>:
				who has a project open, where their pointer is, what they have selected.
				Each connected peer publishes its own state on a pulse, and everyone
				subscribed to that pulse sees it until the peer leaves.
			</p>
			<table>
				<thead>
					<tr>
						<th />
						<th>Pulse data</th>
						<th>Presence</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">Stored</th>
						<td>In your database, with its history</td>
						<td>Nowhere</td>
					</tr>
					<tr>
						<th scope="row">Who writes it</th>
						<td>Editors, into one shared document</td>
						<td>Every peer, readers included, into its own state</td>
					</tr>
					<tr>
						<th scope="row">Conflicts</th>
						<td>Merged by the CRDT</td>
						<td>None: nobody else writes my state</td>
					</tr>
					<tr>
						<th scope="row">When a peer leaves</th>
						<td>Its edits stay</td>
						<td>Its state disappears for everyone</td>
					</tr>
				</tbody>
			</table>

			<h2>Define a channel</h2>
			<p>
				A channel is a name and a schema. The schema is any codec schema, the
				same vocabulary as a pulse, so a state can hold whatever your app needs.
				A state is always replaced as a whole.
			</p>
			<CodeBlock title="presence.ts" code={define} />
			<p>
				Use one channel per kind of state rather than one large object. A
				pointer that moves 30 times a second then never resends a name and a
				color, and a library can bring its own channel without knowing yours.
			</p>

			<h2>Join, publish, read</h2>
			<p>
				<code>joinPresence</code> works on any pulse, loaded or created,
				connected or not. It returns the channel of that pulse: your state, the
				state of the others, and a subscription.
			</p>
			<CodeBlock title="viewers.ts" code={join} />
			<p>
				Presence belongs to one pulse. On a project it says who has the project
				open; on one of its{" "}
				<a href="/docs/pulse-methods#sub-pulses">sub-pulses</a> it says who is
				in that document.
			</p>

			<h2>Several channels</h2>
			<p>
				A peer is one connected session: a tab, a window, a device. It has the
				same <code>peer</code> number in every channel of a pulse, which is how
				a cursor finds its owner's color.
			</p>
			<CodeBlock title="cursors.ts" code={several} />

			<h2>Text cursors</h2>
			<p>
				An index into a <code>richText()</code> field is not a cursor: it points
				somewhere else as soon as someone types before it. Publish an{" "}
				<strong>anchor</strong> instead, a string that follows its character
				through every edit.
			</p>
			<CodeBlock title="anchors.ts" code={anchors} />
			<p>
				With ProseMirror or Lexical you write none of this: one option of the
				binding shares your selection and draws the others.{" "}
				<a href="/docs/editors#remote-cursors">Remote cursors →</a>
			</p>

			<h2>Leaving</h2>
			<p>
				Nobody has to say goodbye. The relay knows when a session ends and tells
				the others, so there is no heartbeat and nothing is sent while nothing
				changes.
			</p>
			<table>
				<thead>
					<tr>
						<th>What happens</th>
						<th>What the others see</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>
							<code>set(state)</code>
						</td>
						<td>My state, at most one update per throttle interval</td>
					</tr>
					<tr>
						<td>
							<code>set(undefined)</code>
						</td>
						<td>I am gone from this channel. I still see them.</td>
					</tr>
					<tr>
						<td>
							<code>leave()</code>, <code>disconnectPulse</code>,{" "}
							<code>destroyPulse</code>
						</td>
						<td>I am gone, and I stop receiving</td>
					</tr>
					<tr>
						<td>The tab closes or crashes, the network drops</td>
						<td>I am gone as soon as the relay sees the socket close</td>
					</tr>
					<tr>
						<td>My access to the pulse is revoked</td>
						<td>I am gone at once, and I stop receiving</td>
					</tr>
					<tr>
						<td>I reconnect</td>
						<td>I am back with the state I last set, as a new peer</td>
					</tr>
				</tbody>
			</table>
			<p>
				While you are offline, <code>others</code> is empty and{" "}
				<code>mine</code> is kept: <code>set</code> still works and the latest
				state is sent when the connection returns.
			</p>
			<CodeBlock title="leave.ts" code={leave} />
			<p>
				Joins are counted. Each <code>joinPresence</code> is undone by its own{" "}
				<code>leave()</code>, and the channel closes with the last one, so two
				parts of an app can share a channel without coordinating.
			</p>

			<h2>Frontend frameworks</h2>
			<p>
				Each binding joins when a component appears, leaves when it goes, and
				makes <code>others</code> and <code>mine</code> reactive. All four
				return the same three members: <code>others</code>, <code>mine</code>{" "}
				and <code>set</code>.
			</p>
			<table>
				<thead>
					<tr>
						<th>Framework</th>
						<th>Call</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>
							<a href="/docs/frontend/svelte#presence">Svelte</a>
						</td>
						<td>
							<code>new SveltePresence(pulse, Cursor)</code>
						</td>
					</tr>
					<tr>
						<td>
							<a href="/docs/frontend/solid#presence">Solid</a>
						</td>
						<td>
							<code>createPulsePresence(pulse, Cursor)</code>
						</td>
					</tr>
					<tr>
						<td>
							<a href="/docs/frontend/react#presence">React</a>
						</td>
						<td>
							<code>usePulsePresence(pulse, Cursor)</code>
						</td>
					</tr>
					<tr>
						<td>
							<a href="/docs/frontend/vue#presence">Vue</a>
						</td>
						<td>
							<code>usePulsePresence(pulse, Cursor)</code>
						</td>
					</tr>
				</tbody>
			</table>

			<h2>Other frameworks</h2>
			<p>
				The four bindings use nothing but the object that{" "}
				<code>joinPresence</code> returns. Any other framework, or none, can do
				the same:
			</p>
			<CodeBlock title="pulsify-core" code={contract} />
			<p>What a binding can rely on:</p>
			<ul>
				<li>
					<strong>Values that compare by identity.</strong> States and arrays
					are never mutated. <code>others</code> is a new array only when
					something changed, and a peer whose state did not change keeps the
					same object. A framework that compares with <code>===</code>{" "}
					re-renders exactly what moved.
				</li>
				<li>
					<strong>One subscription.</strong> The listener is called at once with
					the current state, then synchronously after every change, and a last
					time when its holder leaves: when it runs, <code>others</code> and{" "}
					<code>mine</code> are already up to date. This is the store contract
					of Svelte, and one line connects it to a signal or to a component's
					update request.
				</li>
				<li>
					<strong>Counted joins.</strong> Join when a component appears and call{" "}
					<code>leave()</code> when it goes. Calling it twice is harmless, and
					other holders of the channel are not affected.
				</li>
				<li>
					<strong>No order to respect.</strong> Joining and setting work before
					the pulse is connected and while it is offline, without throwing. A
					binding needs no connection logic.
				</li>
				<li>
					<strong>Browser only.</strong> Like a pulse, a presence never exists
					on a server, so there is nothing to render there or to hydrate.
				</li>
			</ul>

			<h2>Trust</h2>
			<p>
				A state is whatever its peer says: a name in it is a label, not an
				identity. Two things come from the relay instead and cannot be forged by
				a client.
			</p>
			<ul>
				<li>
					<strong>
						<code>peer</code>
					</strong>{" "}
					is given by the relay to each session. A client cannot publish under
					the number of another.
				</li>
				<li>
					<strong>
						<code>subject</code>
					</strong>{" "}
					is the user the relay authenticated. On{" "}
					<a href="/docs/cloud/authentication">Pulsify Cloud</a> it is the
					subject of the token. On <a href="#your-own-relay">your own relay</a>,
					it is what you pass when you open the session.
				</li>
			</ul>
			<p>
				Readers can publish presence: it is not a write to the document. A peer
				without access to a pulse neither sends nor receives it.
			</p>

			<h2>Your own relay</h2>
			<p>
				Pulsify Cloud is a relay and a database run for you; nothing about
				presence is reserved to it. A relay stores no presence: it forwards
				frames between the sessions of a document and says when one ends.
			</p>
			<p>
				<strong>
					With <code>PulseRelay</code>
				</strong>
				, there is nothing to add. The server of{" "}
				<a href="/docs/auth">Self-hosting</a> relays presence as it is.
			</p>
			<CodeBlock title="server.ts" code={memoryRelay} />
			<p>
				<strong>
					With <code>relayStoreMessage</code>
				</strong>
				, your server owns the sockets, so it does the forwarding. Presence adds
				the commented lines to a relay that serves a database: a peer number per
				session, one more frame to forward, and a goodbye when a socket closes.
			</p>
			<CodeBlock title="server.ts" code={storeRelay} />
			<ul>
				<li>
					<strong>A peer number</strong> is any positive integer that no other
					open session of the document uses: a counter in one process, a random
					number across several.
				</li>
				<li>
					<strong>Forward presence only to sessions that sent some.</strong> A
					client older than version 9 rejects a frame it does not know, and
					would stop synchronizing.
				</li>
				<li>
					<strong>
						Clients throttle themselves; a relay cannot trust them to.
					</strong>{" "}
					<code>PulseRelay</code> and Pulsify Cloud drop what a session sends
					beyond 200 frames a second. <code>createPresenceBudget()</code> from{" "}
					<code>pulsify-core/protocol</code> gives your relay the same rule.
				</li>
			</ul>

			<h2>Where it works</h2>
			<p>
				Presence travels through relays. A local store keeps documents and has
				nobody to relay to, so a pulse with a local and a remote connector uses
				the remote one. A pulse uses one relay for presence: the first of its
				connectors, in order, that relays it. If that connection fails, the next
				one takes over and the peers come back with new numbers.
			</p>
			<table>
				<thead>
					<tr>
						<th>Connector</th>
						<th>Presence</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>
							<a href="/docs/cloud">Pulsify Cloud</a>
						</td>
						<td>Yes, nothing to configure</td>
					</tr>
					<tr>
						<td>
							WebSocket to <a href="#your-own-relay">your own relay</a>
						</td>
						<td>
							Yes, with <code>presence: true</code>
						</td>
					</tr>
					<tr>
						<td>Memory connector</td>
						<td>Yes</td>
					</tr>
					<tr>
						<td>IndexedDB, Electron, Tauri</td>
						<td>No: local stores</td>
					</tr>
				</tbody>
			</table>
			<CodeBlock title="connectors.ts" code={optIn} />
			<p>
				The option is explicit because a relay older than version 9 rejects
				frames it does not know. Without it, <code>joinPresence</code> still
				works and <code>others</code> stays empty.
			</p>

			<h2>Limits</h2>
			<ul>
				<li>
					<strong>16 KiB per state</strong>, once encoded. Presence is for small
					values that change often.
				</li>
				<li>
					<strong>No array or set of empty values.</strong>{" "}
					<code>array("null")</code> or an array of empty objects is refused by{" "}
					<code>definePresence</code>: nothing in 16 KiB would bound its length.
					Give the elements a field.
				</li>
				<li>
					<strong>Throttled sending.</strong> A channel sends its first state at
					once, then the latest one at most every <code>throttleMs</code> (50 by
					default). Receivers get every state that was sent, in order.
				</li>
				<li>
					<strong>No migrations.</strong> Peers whose channel has the same name
					but another schema do not see each other, instead of decoding the
					wrong bytes. During a deployment, old and new clients are briefly
					invisible to one another in that channel.
				</li>
				<li>
					<strong>The relay keeps nothing.</strong> A newcomer receives the
					current states from the peers themselves, a moment after joining.
				</li>
				<li>
					<strong>Presence never breaks a document.</strong> A state that cannot
					be decoded, or a channel a peer has not joined, is ignored: the pulse
					keeps synchronizing.
				</li>
				<li>
					<strong>Names are short.</strong> A channel name and a{" "}
					<code>subject</code> hold at most 256 characters.
				</li>
			</ul>
		</>
	);
}
