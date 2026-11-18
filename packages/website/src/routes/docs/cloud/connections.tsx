import { Seo } from "~/components/Seo";
import { CodeBlock } from "~/components/CodeBlock";
import { Tabs } from "~/components/Tabs";

const heartbeat = `import { createCloudConnector, createUserActivity } from "pulsify-cloud";

const cloud = createCloudConnector({
  url,
  token,
  heartbeat: {
    staleMs: 5_000,    // ping a socket silent this long before using it
    timeoutMs: 5_000,  // no frame this long after a ping: the socket is dead
    intervalMs: 2_000, // background check while someone is there; false = on demand only
  },                   // defaults; heartbeat: false relies on transport errors
  // Optional: by default every connector of the page shares \`userActivity\`.
  activity: createUserActivity({
    activeMs: 300_000,   // "someone is there": input within this long, page not hidden
    unfocusedMs: 30_000, // ...or within this long when the window lost focus
  }),
});`;

const tauriActivity = `// Tauri, desktop and mobile: minimized or hidden means away, shown or focused means back.
import { userActivity } from "pulsify-cloud";
import { watchTauriActivity } from "pulsify-tauri";

const stop = await watchTauriActivity(userActivity);`;

const electrobunActivity = `// Electrobun, main process (Bun): report the native window state.
const report = (present: boolean) => sendToWebview("activity", present); // your RPC message
const update = () => report(win.isVisible() && !win.isMinimized());
win.on("resize", update);
win.on("blur", update);
win.on("focus", () => report(true));

// Webview: hand it to the page's user activity, shared by every connector.
import { userActivity } from "pulsify-cloud";

onActivityMessage((present) => userActivity.set(present));`;

const debug = `import { userActivity } from "pulsify-cloud";
import { subscribePulseStatus } from "pulsify-core";

// The window: called now, then on every change. It involves no server.
userActivity.on("change", (p) => {
  // { present, reason: "blur" | "idle" | "focus" | "native" | …, visible, focused, away, lastActivity }
  activityBadge.textContent = p.present ? "here" : \`away (\${p.reason})\`;
});

// The servers: one connection per root, to the instance that hosts it.
// Called with the current connections, then with each new one (reconnections included).
cloud.onConnection((connection) => {
  const { root } = connection;
  connection.on("server", ({ backend, id, location }) => log(root, "served by", backend, id, location));
  connection.on("state", (state, error) => log(root, state, error?.message)); // open | closed
  connection.on("ping", (reason) => log(root, "ping", reason)); // send | interval | network | return | resume
  connection.on("pong", (latencyMs) => log(root, "pong", latencyMs));
  connection.on("timeout", (waitedMs) => log(root, "dead socket", waitedMs));
  connection.on("suspended", (gapMs) => log(root, "process was suspended for", gapMs));
  connection.on("role", (docId, role) => log(docId, "role", role));
});

cloud.connections; // the current ones, without listening: root, state, server, documents, latencyMs, error
userActivity.state; // the same for the window

// Documents: idle | syncing | ready | synced | offline | error.
subscribePulseStatus(notebook, (status) => (statusBadge.textContent = status));`;

export default function CloudConnections() {
	return (
		<>
			<Seo
				title="Cloud connections · Pulsify Docs"
				description="How the Pulsify Cloud connector detects sockets that died silently, what it does in desktop and mobile webviews, and the events to log or display."
			/>
			<h1>Connections</h1>
			<p>
				The connector opens <a href="/docs/cloud">one socket per root</a>. This
				page covers what happens when one is lost, and the events to watch them.
			</p>

			<h2>Lost connections</h2>
			<p>
				Connected pulses <a href="/docs/sync">reconnect on their own</a> with
				backoff, and every reconnection is a complete synchronization. All
				documents of a root come back on one new socket.
			</p>
			<p>
				A socket can also die without closing: a laptop that slept, a network
				switch, a proxy dropping idle connections. The connector checks sockets
				when they are needed, once per socket rather than per document:
			</p>
			<ul>
				<li>
					<strong>Before using a silent socket.</strong> An edit sent on a
					socket that received nothing for 5 seconds goes out with a ping. Any
					frame counts as an answer, so a busy socket never pings.
				</li>
				<li>
					<strong>When the user comes back.</strong> Focusing the window or
					showing the page checks silent sockets; the network coming back checks
					all of them.
				</li>
				<li>
					<strong>Without an answer within 5 seconds</strong>, the socket is
					closed and its documents reconnect, the edit included.
				</li>
				<li>
					<strong>Passive readers.</strong> Nothing needs a socket that only
					receives, so while someone is there (input in the last 5 minutes, page
					not hidden) a silent socket is pinged every 2 seconds. Any frame
					counts as an answer, so busy sockets never ping. Set{" "}
					<code>intervalMs: false</code> to check on demand only.
				</li>
				<li>
					<strong>A page left open</strong> (hidden, or untouched for 5 minutes)
					sends nothing at all, so the server can sleep. Its sockets stay open
					and still receive updates; if one died meanwhile, the first input,
					focus or edit finds out within 5 seconds and resynchronizes.
				</li>
			</ul>
			<CodeBlock title="cloud.ts" code={heartbeat} />
			<p>
				Pings are answered without waking the root: a hibernated root stays
				asleep. Only pages in use ping in the background, so a root costs
				nothing once its users walk away.
			</p>
			<p>
				A screen nobody touches, such as a dashboard on an office TV or a kiosk,
				stops background pings after 5 minutes like any idle page. It still
				receives updates, but a socket that died silently would only be noticed
				at the next touch. Give such displays <code>activeMs: Infinity</code>.
			</p>

			<h3>Desktop and mobile apps</h3>
			<p>
				User activity works in every webview because it relies on what they all
				report: input events (pointer, keyboard, wheel, touch) and timers. When
				timers run late, the process was suspended (laptop sleep, mobile app in
				the background), and every socket is checked on resume. Visibility,
				focus, <code>pageshow</code> and <code>resume</code> only make detection
				faster where the webview reports them:
			</p>
			<table>
				<thead>
					<tr>
						<th>Runtime</th>
						<th>Page hidden when minimized or in the background</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>Browsers, Electron (Chromium)</td>
						<td>Yes</td>
					</tr>
					<tr>
						<td>Tauri, Electrobun on macOS (WKWebView)</td>
						<td>On minimize, not when covered by another window</td>
					</tr>
					<tr>
						<td>Tauri, Electrobun on Windows (WebView2)</td>
						<td>
							Never (
							<a href="https://github.com/tauri-apps/tauri/issues/10592">
								tauri#10592
							</a>
							). Minimizing removes the focus, so pings stop 30 seconds after
							the last input; at once with native events.
						</td>
					</tr>
					<tr>
						<td>Tauri on iOS and Android</td>
						<td>
							The app is suspended in the background; sockets are checked on
							resume
						</td>
					</tr>
				</tbody>
			</table>
			<p>
				A window that loses focus (another app in front, or minimized) counts as
				away 30 seconds after the last input instead of 5 minutes. Every webview
				reports focus, including WebView2. To react the moment a window is
				minimized or hidden, forward the native state to the page's{" "}
				<code>userActivity</code>, which every connector shares:
			</p>
			<Tabs
				tabs={[
					{
						label: "Tauri",
						content: <CodeBlock title="activity.ts" code={tauriActivity} />,
					},
					{
						label: "Electrobun",
						content: (
							<CodeBlock title="activity.ts" code={electrobunActivity} />
						),
					},
				]}
			/>
			<p>
				Electron needs nothing: Chromium reports minimized and hidden windows to
				the page.
			</p>

			<h2>Debugging and status displays</h2>
			<p>
				A client talks to several servers at once: each root it uses has its own
				socket, served by the instance that hosts that root. So events are
				reported where they happen:
			</p>
			<ul>
				<li>
					<strong>User activity</strong> belongs to the window, not to any
					server: whether someone is there, and why.
				</li>
				<li>
					<strong>Each connection</strong> reports its own server (the first
					frame of every socket names the backend, the instance ID and its
					location), its lifecycle, every ping with why it was sent, round
					trips, a dead socket and process suspensions. A reconnection is a new
					connection; a new server ID means a new instance.
				</li>
				<li>
					<strong>Each pulse</strong> reports its synchronization status.
				</li>
			</ul>
			<p>Use them for a debug panel, logs, or to show the state of a window.</p>
			<CodeBlock title="debug.ts" code={debug} />
		</>
	);
}
