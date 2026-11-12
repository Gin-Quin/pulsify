import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Icon } from "./Icon";
import styles from "./HeroDiagram.module.css";

/*
 * The hero illustration. An app is a sandwich: the app itself between two
 * slabs of the same CRDT layer. That layer talks to its local database and
 * to a sync server; the other apps are only reached through that server,
 * which stores every patch and forwards it. Geometry
 * is in viewBox units; the animation is one SMIL timeline, in seconds,
 * scripted by the scenarios below.
 */

const WIDTH = 720;
const HEIGHT = 725;
const VIEW_BOX = `0 0 ${WIDTH} ${HEIGHT}`;

/** Speed of a pulse along a link, in units per second. */
const SPEED = 240;
/** Length of the trail behind a pulse. */
const TRAIL = 34;
/** Seconds between two scenarios. */
const PAUSE = 1.9;

// ---------------------------------------------------------------- geometry

/** A polygon with rounded corners. */
function rounded(corners: number[][]) {
	const toward = (from: number[], to: number[]) =>
		`${from[0] + (to[0] - from[0]) * 0.14} ${from[1] + (to[1] - from[1]) * 0.14}`;
	return `${corners
		.map((corner, i) => {
			const before = corners[(i + corners.length - 1) % corners.length];
			const after = corners[(i + 1) % corners.length];
			return `${i ? "L" : "M"}${toward(corner, before)}Q${corner[0]} ${corner[1]} ${toward(corner, after)}`;
		})
		.join("")}Z`;
}

/** A diamond with rounded corners: an isometric slab seen from above. */
const diamond = (cx: number, cy: number, rx: number, ry: number) =>
	rounded([
		[cx, cy - ry],
		[cx + rx, cy],
		[cx, cy + ry],
		[cx - rx, cy],
	]);

/** Where an app's top slab sits, and how its slabs are spaced. */
type Stack = { x: number; y: number; rx: number; ry: number; gap: number };

/** The slabs of an app, bottom first: CRDT layer, app, CRDT layer. */
const slabsOf = (stack: Stack) =>
	[2, 1, 0].map((depth) =>
		diamond(stack.x, stack.y + depth * stack.gap, stack.rx, stack.ry),
	);
const slabClasses = [styles.crdt, styles.app, styles.crdt];

type Database = {
	class: string;
	x: number;
	/** Center of the top face. */
	y: number;
	rx: number;
	ry: number;
	height: number;
	bands: number;
};

const cylinder = (db: Database) =>
	`M${db.x - db.rx} ${db.y}v${db.height}a${db.rx} ${db.ry} 0 0 0 ${2 * db.rx} 0v${-db.height}a${db.rx} ${db.ry} 0 0 0 ${-2 * db.rx} 0Z`;

/** The front half of a ring around the cylinder, `index` bands down. */
const band = (db: Database, index: number) =>
	`M${db.x - db.rx} ${db.y + (db.height * index) / (db.bands + 1)}a${db.rx} ${db.ry} 0 0 0 ${2 * db.rx} 0`;

type Link = { d: string; length: number };

const APP: Stack = { x: 360, y: 292, rx: 230, ry: 72, gap: 78 };
const appSlabs = slabsOf(APP);

/** Where the app's upper (`side` -1) or lower (1) edge is, at `x`. */
const edge = (x: number, side: -1 | 1) =>
	APP.y +
	(side + 1) * APP.gap +
	side * (APP.ry * (1 - Math.abs(x - APP.x) / APP.rx) - 4);

/** A straight wire from the app's edge, up or down to `y`. */
function wire(x: number, y: number): Link {
	const from = edge(x, y < APP.y ? -1 : 1);
	return { d: `M${x} ${from}V${y}`, length: Math.abs(y - from) };
}

const databaseAt = (x: number, name: string): Database => ({
	class: name,
	x,
	y: 592,
	rx: 70,
	ry: 16,
	height: 66,
	bands: 2,
});
const localDatabase = databaseAt(APP.x, styles.local);
/** Where the labels above the diagram sit. */
const TOP_LABEL = 40;

/**
 * The sync server, above the app: the hub every app connects to. An
 * isometric box, `y` being the center of its top face.
 */
const server = { x: APP.x, y: 80, rx: 54, ry: 18, height: 40 };
const serverBody = rounded([
	[server.x, server.y - server.ry],
	[server.x + server.rx, server.y],
	[server.x + server.rx, server.y + server.height],
	[server.x, server.y + server.ry + server.height],
	[server.x - server.rx, server.y + server.height],
	[server.x - server.rx, server.y],
]);
const serverTop = diamond(server.x, server.y, server.rx, server.ry);
/** The box's front edge, between its rounded corners. */
const serverEdge = `M${server.x} ${server.y + server.ry * 0.93}V${server.y + server.ry * 0.93 + server.height}`;
/** The server's database: beside it like an app's, but under the link to Mobile. */
const serverDatabase: Database = {
	class: styles.remote,
	x: server.x + server.rx + 10 + 22,
	y: 116,
	rx: 22,
	ry: 7,
	height: 26,
	bands: 1,
};

const links = {
	local: wire(localDatabase.x, localDatabase.y - localDatabase.ry),
	server: wire(server.x, server.y + server.ry + server.height - 1),
};

/** What a scenario can light up. */
type Node =
	| { kind: "slabs"; indexes: number[] }
	| { kind: "stack"; slabs: string[] }
	| { kind: "database"; database: Database };

/**
 * The other apps, on each side of the server and wired to it, never to your
 * app. `side` is where each sits, and keeps its database.
 */
const peers = (
	[
		{ x: 150, y: 83, side: -1, label: "Web", icon: "globe" },
		{ x: 570, y: 83, side: 1, label: "Mobile", icon: "phone" },
	] as const
).map((peer) => {
	const stack: Stack = { x: peer.x, y: peer.y, rx: 62, ry: 21, gap: 16 };
	const database: Database = {
		class: styles.local,
		x: peer.x + peer.side * (stack.rx + 34),
		y: peer.y + 12,
		rx: 24,
		ry: 7,
		height: 28,
		bands: 1,
	};
	const slabs = slabsOf(stack);
	return {
		...peer,
		stack,
		slabs,
		database,
		/** From the server's side to the app's inner corner. */
		link: {
			d: `M${server.x + peer.side * server.rx} ${peer.y + stack.gap}H${peer.x - peer.side * (stack.rx - 3)}`,
			length: Math.abs(server.x - peer.x) - server.rx - stack.rx + 3,
		} satisfies Link,
		node: { kind: "stack", slabs } satisfies Node,
		store: { kind: "database", database } satisfies Node,
	};
});
type Peer = (typeof peers)[number];

/** The two slabs around the app are one layer: they always light together. */
const crdt: Node = { kind: "slabs", indexes: [0, 2] };
const app: Node = { kind: "slabs", indexes: [1] };
const local: Node = { kind: "database", database: localDatabase };
const hub: Node = { kind: "stack", slabs: [serverBody, serverTop] };
const hubStore: Node = { kind: "database", database: serverDatabase };

const databases = [
	localDatabase,
	serverDatabase,
	...peers.map((peer) => peer.database),
];

/** Every outlined shape, back to front. Their glows are blurred in one pass. */
const shapes = [
	...appSlabs.map((d, i) => ({
		class: `${slabClasses[i]} ${styles.solid}`,
		d,
	})),
	...peers.flatMap((peer) =>
		peer.slabs.map((d, i) => ({
			class: `${slabClasses[i]} ${styles.solid} ${styles.small}`,
			d,
		})),
	),
	...[serverBody, serverTop].map((d) => ({
		class: `${styles.remote} ${styles.solid}`,
		d,
	})),
	...databases.map((database) => ({
		class: database.class,
		d: cylinder(database),
	})),
];

const wires = [
	links.local.d,
	links.server.d,
	...peers.flatMap((peer) => [
		peer.link.d,
		// An app to its own database.
		`M${peer.x + peer.side * (peer.stack.rx - 3)} ${peer.y + peer.stack.gap}h${peer.side * 16}`,
	]),
];

// ---------------------------------------------------------------- timeline

/** Patches are edits on their way; a sync is two sides comparing notes. */
type Tone = "patch" | "sync";

type Effect =
	| { type: "pulse"; link: Link; at: number; tone: Tone; reverse: boolean }
	| { type: "light"; node: Node; at: number; tone: Tone }
	| { type: "ping"; x: number; y: number; at: number; tone: Tone };

const effects: Effect[] = [];

/** Sends a pulse away from the app, or back to it. Returns when it arrives. */
function pulse(link: Link, at: number, tone: Tone = "patch", reverse = false) {
	effects.push({ type: "pulse", link, at, tone, reverse });
	return at + link.length / SPEED;
}

function light(node: Node, at: number, tone: Tone = "patch") {
	effects.push({ type: "light", node, at, tone });
}

/** The server forwards a patch to every app but its sender. Returns when the last one has stored it. */
function forward(at: number, sender?: Peer) {
	let done = at;
	for (const peer of peers) {
		if (peer === sender) continue;
		// The app applies the patch, then stores it.
		const arrival = pulse(peer.link, at);
		light(peer.node, arrival);
		light(peer.store, arrival + 0.35);
		done = Math.max(done, arrival + 0.35);
	}
	return done;
}

/** The server receives a patch, or a question, and checks its database. Returns when it is done. */
function serve(at: number, tone: Tone = "patch") {
	light(hub, at, tone);
	light(hubStore, at + 0.35, tone);
	return at + 0.5;
}

/** Your app makes an edit: ripple, then the CRDT layer turns it into a patch. */
function edit(at: number) {
	light(app, at);
	effects.push({
		type: "ping",
		x: APP.x,
		y: APP.y + APP.gap + 18,
		at,
		tone: "patch",
	});
	light(crdt, at + 0.45);
}

/** Each scenario plays from `at` and returns when it is over. */
const scenarios: { name: string; detail: string; play(at: number): number }[] =
	[
		{
			name: "Send patch",
			detail:
				"Your app applies the edit at once. The CRDT layer stores the patch in the local database and sends it to the sync server, which stores it and forwards it to every other connected app.",
			play(at) {
				edit(at);
				const sent = at + 0.75;
				light(local, pulse(links.local, sent));
				return forward(serve(pulse(links.server, sent)));
			},
		},
		{
			name: "Receive patch",
			detail:
				"Another app sends its patch to the sync server, which forwards it to every other connected app. Yours merges it and stores it in its local database.",
			play(at) {
				const sender = peers[0];
				light(sender.node, at);
				effects.push({
					type: "ping",
					x: sender.x,
					y: sender.y,
					at,
					tone: "patch",
				});
				light(sender.store, at + 0.35);
				const out = serve(pulse(sender.link, at + 0.5, "patch", true));
				const others = forward(out, sender);
				const arrival = pulse(links.server, out, "patch", true);
				light(crdt, arrival);
				light(app, arrival + 0.3);
				const kept = pulse(links.local, arrival + 0.4);
				light(local, kept);
				return Math.max(others, kept);
			},
		},
		{
			name: "Synchronize",
			detail:
				"Back online, your app first reads its local database. Then it trades missing patches with the sync server, which passes your offline edits on to the other apps.",
			play(at) {
				// Local database first: load what it holds.
				light(crdt, at, "sync");
				const asked = pulse(links.local, at + 0.25, "sync");
				light(local, asked, "sync");
				const loaded = pulse(links.local, asked + 0.5, "patch", true);
				light(crdt, loaded);
				light(app, loaded + 0.3);
				// Then the server: compare versions, download, upload.
				const now = loaded + 1.1;
				light(crdt, now, "sync");
				const compared = serve(pulse(links.server, now + 0.25, "sync"), "sync");
				const missed = pulse(links.server, compared, "patch", true);
				light(crdt, missed);
				light(app, missed + 0.3);
				return forward(serve(pulse(links.server, missed + 0.9)));
			},
		},
	];

/** Seconds a scenario is announced before it plays. */
const LEAD = 0.4;

let clock = LEAD;
const scenes = scenarios.map((scenario) => {
	const start = clock;
	clock = scenario.play(start) + PAUSE;
	return { ...scenario, start, end: clock };
});

/** Seconds for one pass through every scenario. */
const LOOP = clock;
/** Where the loop stops for people who prefer reduced motion: the first patch, on its way out. */
const STILL = scenes[0].start + 1;

/** The scenario playing at `time`. */
const sceneAt = (time: number) =>
	Math.max(
		0,
		scenes.findLastIndex((scene) => time >= scene.start - LEAD),
	);

// --------------------------------------------------------------- animation

type Frames = [seconds: number, value: number][];

/** Animates an attribute on the shared loop, holding the first and last values outside the frames. */
function Animate(props: { attribute: string; frames: Frames }) {
	const frames: Frames = [
		[0, props.frames[0][1]],
		...props.frames,
		[LOOP, props.frames[props.frames.length - 1][1]],
	];
	return (
		<animate
			attributeName={props.attribute}
			dur={`${LOOP}s`}
			repeatCount="indefinite"
			keyTimes={frames.map(([time]) => time / LOOP).join(";")}
			values={frames.map(([, value]) => value).join(";")}
		/>
	);
}

/** A glowing dot and its trail, running along a link from `at`. */
function Pulse(props: { link: Link; at: number; reverse: boolean }) {
	const { d, length } = props.link;
	const end = props.at + (length + TRAIL) / SPEED;
	// The dot leads a dash across the link, from just before it to a trail past it.
	const layer = (name: string, dash: number) => {
		const hidden = props.reverse ? -length - 1 : dash + 1;
		const gone = props.reverse ? TRAIL + 1 : dash - length - TRAIL - 1;
		return (
			<path
				class={name}
				d={d}
				pathLength={length}
				stroke-dasharray={`${dash} ${length + 3 * TRAIL}`}
				stroke-dashoffset={hidden}
			>
				<Animate
					attribute="stroke-dashoffset"
					frames={[
						[props.at, hidden],
						[end, gone],
					]}
				/>
			</path>
		);
	};
	return (
		<>
			{layer(styles.trail, TRAIL)}
			{layer(styles.halo, 0.01)}
			{layer(styles.head, 0.01)}
		</>
	);
}

/** A ring that spreads from where an edit is made. */
function Ping(props: { x: number; y: number; at: number }) {
	return (
		<circle class={styles.ping} cx={props.x} cy={props.y} r="4" opacity="0">
			<Animate
				attribute="r"
				frames={[
					[props.at, 4],
					[props.at + 0.8, 48],
				]}
			/>
			<Animate
				attribute="opacity"
				frames={[
					[props.at - 0.01, 0],
					[props.at, 0.9],
					[props.at + 0.8, 0],
				]}
			/>
		</circle>
	);
}

/** A node flaring up as data reaches it. */
function Light(props: { node: Node; at: number }) {
	const node = props.node;
	let shape: JSX.Element;
	if (node.kind === "slabs") {
		shape = node.indexes.map((index) => (
			<path
				class={styles.surge}
				d={appSlabs[index]}
				// The slab above hides part of this one.
				clip-path={
					index < appSlabs.length - 1 ? `url(#hero-under-${index})` : undefined
				}
			/>
		));
	} else if (node.kind === "stack") {
		shape = node.slabs.map((d) => <path class={styles.lit} d={d} />);
	} else {
		const { x, y, rx, ry } = node.database;
		shape = (
			<g class={styles.stored}>
				<ellipse cx={x} cy={y} rx={rx} ry={ry} />
				<path d={band(node.database, 1)} />
			</g>
		);
	}
	return (
		<g opacity="0">
			<Animate
				attribute="opacity"
				frames={[
					[props.at - 0.01, 0],
					[props.at + 0.12, 1],
					[props.at + 0.6, 1],
					[props.at + 1.1, 0],
				]}
			/>
			{shape}
		</g>
	);
}

// ------------------------------------------------------------------ render

export function HeroDiagram() {
	let motion!: SVGSVGElement;
	let reducedMotion = false;
	const [active, setActive] = createSignal(0);

	onMount(() => {
		// SMIL ignores the CSS reduced-motion rule: hold one frame instead.
		reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (reducedMotion) {
			motion.pauseAnimations();
			motion.setCurrentTime(STILL);
			return;
		}
		// The timeline loops on its own: follow it.
		const timer = setInterval(
			() => setActive(sceneAt(motion.getCurrentTime() % LOOP)),
			200,
		);
		onCleanup(() => clearInterval(timer));
	});

	/** Jumps to a scenario: its start, or a frame from its middle when nothing moves. */
	function play(index: number) {
		setActive(index);
		motion.setCurrentTime(scenes[index].start + (reducedMotion ? 1 : -LEAD));
	}

	return (
		<div class={styles.diagram}>
			<div
				class={styles.canvas}
				role="img"
				aria-label="Your app sits inside the Pulsify CRDT layer, which keeps it in sync with its local database and with a sync server; web and mobile apps, each with its own local database, exchange patches with your app through that server"
			>
				{/* Still layer: everything that carries a blur filter, painted once. */}
				<svg class={styles.layer} viewBox={VIEW_BOX} aria-hidden="true">
					<defs>
						<filter
							id="hero-glow"
							filterUnits="userSpaceOnUse"
							x="0"
							y="0"
							width={WIDTH}
							height={HEIGHT}
						>
							<feGaussianBlur stdDeviation="7" />
						</filter>
						<filter id="hero-soft">
							<feGaussianBlur stdDeviation="9" />
						</filter>
						<filter id="hero-soft-small">
							<feGaussianBlur stdDeviation="4" />
						</filter>
						<linearGradient id="hero-glass" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" class={styles.glassTop} />
							<stop offset="1" class={styles.glassBottom} />
						</linearGradient>
						<radialGradient id="hero-aura">
							<stop offset="0" class={styles.auraCore} />
							<stop offset="1" class={styles.auraEdge} />
						</radialGradient>
						{shapes.map((shape, i) => (
							<clipPath id={`hero-shape-${i}`}>
								<path d={shape.d} />
							</clipPath>
						))}
					</defs>

					<ellipse
						cx={APP.x}
						cy={APP.y + APP.gap}
						rx={APP.rx * 1.4}
						ry={APP.ry * 3}
						fill="url(#hero-aura)"
					/>

					{wires.map((d) => (
						<path class={styles.wire} d={d} />
					))}

					<g filter="url(#hero-glow)">
						{shapes.map((shape) => (
							<path class={`${styles.glow} ${shape.class}`} d={shape.d} />
						))}
					</g>
					{shapes.map((shape, i) => (
						<g class={shape.class}>
							<path class={styles.glass} d={shape.d} fill="url(#hero-glass)" />
							{/* The glow again, kept inside the shape: light caught in the glass. */}
							<g clip-path={`url(#hero-shape-${i})`}>
								<path
									class={styles.sheen}
									d={shape.d}
									filter={`url(#hero-soft${shape.class.includes(styles.small) ? "-small" : ""})`}
								/>
							</g>
							<path class={styles.rim} d={shape.d} />
						</g>
					))}

					{databases.map((database) => (
						<g class={database.class}>
							<ellipse
								class={styles.face}
								cx={database.x}
								cy={database.y}
								rx={database.rx}
								ry={database.ry}
							/>
							{Array.from({ length: database.bands }, (_, i) => (
								<path class={styles.detail} d={band(database, i + 1)} />
							))}
						</g>
					))}

					{/* The app: the layer is named once, on the slab with room for it. */}
					<g class={styles.crdt}>
						<g transform={`translate(261 ${APP.y - 22})`}>
							<Icon name="sync" size="44" />
						</g>
						<text class={styles.title} x="319" y={APP.y - 1}>
							Pulsify
						</text>
						<text class={styles.subtitle} x="320" y={APP.y + 24}>
							CRDT layer
						</text>
					</g>
					<g class={styles.app}>
						<g transform={`translate(281 ${APP.y + APP.gap + 3})`}>
							<Icon name="window" size="30" />
						</g>
						<text class={styles.name} x="322" y={APP.y + APP.gap + 27}>
							Your app
						</text>
					</g>

					{peers.map((peer) => (
						<>
							<g
								class={styles.badge}
								transform={`translate(${peer.x - 12} ${peer.y - 12})`}
							>
								<Icon name={peer.icon} size="24" />
							</g>
							<text
								class={styles.label}
								x={peer.x}
								y={peer.y - peer.stack.ry - 11}
								text-anchor="middle"
							>
								{peer.label}
							</text>
						</>
					))}
					<text
						class={styles.label}
						x={localDatabase.x}
						y={localDatabase.y + localDatabase.height + localDatabase.ry + 38}
						text-anchor="middle"
					>
						Local database
					</text>
					<g class={styles.remote}>
						<path class={styles.rim} d={serverEdge} />
					</g>
					<g
						class={styles.badge}
						transform={`translate(${server.x - 13} ${server.y - 13})`}
					>
						<Icon name="server" size="26" />
					</g>
					<text
						class={styles.label}
						x={server.x}
						y={TOP_LABEL}
						text-anchor="middle"
					>
						Sync server
					</text>
				</svg>

				{/* Moving layer: no filters, so each frame is cheap to repaint. */}
				<svg
					ref={motion}
					class={`${styles.layer} ${styles.motion}`}
					viewBox={VIEW_BOX}
					aria-hidden="true"
				>
					<defs>
						{/* Everything but the slab above, for each slab that has one. */}
						{appSlabs.slice(1).map((above, i) => (
							<clipPath id={`hero-under-${i}`}>
								<path
									clip-rule="evenodd"
									d={`M0 0H${WIDTH}V${HEIGHT}H0Z${above}`}
								/>
							</clipPath>
						))}
					</defs>

					{effects.map((effect) => (
						<g class={styles[effect.tone]}>
							{effect.type === "pulse" ? (
								<Pulse
									link={effect.link}
									at={effect.at}
									reverse={effect.reverse}
								/>
							) : effect.type === "light" ? (
								<Light node={effect.node} at={effect.at} />
							) : (
								<Ping x={effect.x} y={effect.y} at={effect.at} />
							)}
						</g>
					))}
				</svg>
			</div>
			<div class={styles.scenarios} role="tablist" aria-label="Sync scenarios">
				{scenes.map((scene, i) => (
					<button
						type="button"
						role="tab"
						class={styles.scenario}
						aria-selected={active() === i}
						onClick={() => play(i)}
					>
						<span class={styles.number}>{i + 1}</span>
						{scene.name}
					</button>
				))}
			</div>
			{/* Every text in one cell, so the longest sets the height. */}
			<div class={styles.details}>
				{scenes.map((scene, i) => (
					<p
						class={styles.detail}
						classList={{ [styles.inactive]: active() !== i }}
					>
						{scene.detail}
					</p>
				))}
			</div>
		</div>
	);
}
