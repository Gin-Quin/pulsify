import { constants, Database } from "bun:sqlite";
import type { Server, WebSocketHandler } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	CLOUD_SUBPROTOCOLS,
	CloudError,
	welcomeMessage,
	type CloudEnvelope,
} from "pulsify-cloud";
import {
	CloudRoot,
	errorResponse,
	jsonResponse,
	routeCloudRequest,
	SqliteCloudStorage,
	type CloudMeter,
	type CloudPeer,
	type CloudRootSize,
	type CloudSecrets,
} from "pulsify-cloud-server";

export type LocalCloudOptions = {
	/** Where the roots are stored: `<directory>/<project>/<root>.sqlite`. */
	directory: string;
	/** The token secret and the API key, shared by every project. */
	secrets: CloudSecrets;
	/**
	 * Milliseconds a root waits after its last socket closed before it compacts
	 * its history. Default 60000.
	 */
	compactAfterMs?: number;
	/** Counts and limits what a root serves. Default: everything is served. */
	meter?(project: string, root: string): CloudMeter;
};
export type LocalCloudSocket = {
	id: string;
	project: string;
	root: string;
	subject: string;
	envelope: CloudEnvelope;
};
export type LocalCloud = {
	/** `fetch` and `websocket` of `Bun.serve`, to mount the routes in your own server. */
	fetch(
		request: Request,
		server: Server<LocalCloudSocket>,
	): Promise<Response | undefined>;
	websocket: WebSocketHandler<LocalCloudSocket>;
	/** Close every database, then refuse everything. Call it before stopping the server. */
	close(): void;
};

/** How long a root waits after its last socket closed before it compacts its history. */
export const COMPACT_AFTER_MS = 60_000;
/** The pause between two bounded compaction steps, which lets other events in. */
const COMPACT_STEP_MS = 10;
/** The longest delay a timer takes. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A project is a directory: lower case, so that no two share one on a case-insensitive disk. */
const PROJECT = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A root as a file name. A root is any text without `/`: it may be `..`, be
 * longer than a file name, or differ from another by its case only. Lower-case
 * letters, digits, `-` and `_` stay, so that usual names can be read; every
 * other byte is `%xx`, and a name that would be too long is its hash.
 */
export function rootFileName(root: string): string {
	let name = "";
	for (const byte of new TextEncoder().encode(root)) {
		const character = String.fromCharCode(byte);
		name += /[a-z0-9_-]/.test(character)
			? character
			: `%${byte.toString(16).padStart(2, "0")}`;
	}
	// `~` is never in an encoded name.
	return name.length <= 200
		? name
		: `~${createHash("sha256").update(root).digest("hex")}`;
}

type Root = {
	readonly key: string;
	readonly path: string;
	readonly database: Database;
	readonly storage: SqliteCloudStorage;
	readonly engine: CloudRoot;
	readonly peers: Map<string, CloudPeer>;
	readonly meter: CloudMeter | undefined;
	/** Requests and socket closes in progress: the database stays open under them. */
	busy: number;
	/** Evicted: no longer the root that serves its name. */
	gone: boolean;
	/** Fires once the root stayed without sockets for long enough, at `due`. */
	timer: ReturnType<typeof setTimeout> | undefined;
	due: number;
	/** Where the compaction in progress continues. */
	compaction: unknown;
	/** The frames a meter is still looking at, in the order they arrived. */
	frames: Promise<unknown>;
};

/**
 * Pulsify Cloud on one machine: the same gateway and the same root as the
 * hosted service, with one SQLite file per root instead of one Durable Object.
 * A root lives like a Durable Object too: in memory while it has sockets or
 * waits to compact or expire, out of it otherwise.
 */
export function createLocalCloud(options: LocalCloudOptions): LocalCloud {
	const { directory, secrets, compactAfterMs = COMPACT_AFTER_MS } = options;
	const roots = new Map<string, Root>();
	const instance = `local-${crypto.randomUUID().slice(0, 8)}`;
	let closed = false;

	const open = (project: string, name: string): Root => {
		const key = `${project}/${name}`;
		let root = roots.get(key);
		if (root) return root;
		mkdirSync(join(directory, project), { recursive: true });
		const path = join(directory, project, `${rootFileName(name)}.sqlite`);
		const database = new Database(path);
		// The side files of the write-ahead log exist only while the root is
		// open, also where SQLite keeps them by default (macOS): one file at rest.
		database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
		database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
		const storage = new SqliteCloudStorage(database);
		const peers = new Map<string, CloudPeer>();
		root = {
			key,
			path,
			database,
			storage,
			peers,
			engine: new CloudRoot(name, storage, {
				get: (id) => peers.get(id),
				all: () => peers.values(),
			}),
			meter: options.meter?.(project, name),
			busy: 0,
			gone: false,
			timer: undefined,
			due: 0,
			compaction: undefined,
			frames: Promise.resolve(),
		};
		roots.set(key, root);
		return root;
	};

	const size = (root: Root, sockets = 0): CloudRootSize => ({
		bytes: (
			root.database
				.query(
					"SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()",
				)
				.get() as { bytes: number }
		).bytes,
		connections: root.peers.size + sockets,
	});

	/**
	 * Out of memory, like a Durable Object nobody talks to. The file stays, and
	 * what is in progress ends on the open database: `hold` closes it after.
	 */
	const evict = (root: Root) => {
		clearTimeout(root.timer);
		root.timer = undefined;
		roots.delete(root.key);
		root.gone = true;
		if (!root.busy) root.database.close();
	};

	/** `cloud.expire`'s lifetime ran out, or the root is empty: delete its file. */
	const wipe = async (root: Root) => {
		evict(root);
		for (const suffix of ["", "-wal", "-shm"])
			rmSync(root.path + suffix, { force: true });
		await root.meter?.settle({ bytes: 0, connections: 0 });
	};

	/** Nothing to keep: no document, grant or tombstone. */
	const isEmpty = async (root: Root) =>
		(await root.storage.usage()).rows === 0 &&
		!(await root.storage.loadGrants()).length &&
		!root.database.query("SELECT 1 FROM pulsify_tombstones LIMIT 1").get();

	// ponytail: timers die with the process, where a Durable Object's alarm
	// survives. A root that was waiting compacts or expires after its next
	// socket closes; store `due` in its file if that matters.
	const arm = (root: Root, due: number) => {
		clearTimeout(root.timer);
		root.due = due;
		root.timer = setTimeout(
			() => void idle(root).catch(console.error),
			Math.min(Math.max(0, due - Date.now()), MAX_TIMER_MS),
		);
	};

	/** The root has no socket: compact or expire it once it stayed so for long enough. */
	const rest = async (root: Root) => {
		if (root.gone) return;
		const idleMs = (await root.storage.expiry()) ?? compactAfterMs;
		root.compaction = undefined;
		arm(root, Date.now() + idleMs);
	};

	/**
	 * What the alarm of a Durable Object does: compact while nobody is
	 * connected, a bounded step at a time, or erase a root that expires or is
	 * empty. A root that got a socket back does nothing; the next time its last
	 * socket closes arms the timer again.
	 */
	const idle = async (root: Root) => {
		root.timer = undefined;
		if (root.peers.size) {
			root.compaction = undefined;
			return;
		}
		// A lifetime longer than a timer, or a request in progress: later.
		if (Date.now() < root.due) return arm(root, root.due);
		if (root.busy) return arm(root, Date.now() + COMPACT_STEP_MS);
		if ((await root.storage.expiry()) !== undefined || (await isEmpty(root)))
			return wipe(root);
		root.compaction = await root.storage.compact(root.compaction);
		if (root.compaction !== undefined) arm(root, Date.now() + COMPACT_STEP_MS);
		else evict(root);
	};

	/** Run `work` on a root whose database stays open meanwhile, and evict it after if nothing keeps it. */
	const hold = async <T>(root: Root, work: () => Promise<T>): Promise<T> => {
		root.busy++;
		try {
			return await work();
		} finally {
			root.busy--;
			if (root.busy) {
				// Someone else is still at work.
			} else if (root.gone) root.database.close();
			else if (!root.peers.size && !root.timer) evict(root);
		}
	};

	const rootOf = (socket: { data: LocalCloudSocket }) => {
		const root = roots.get(`${socket.data.project}/${socket.data.root}`);
		const peer = root?.peers.get(socket.data.id);
		// A deleted root is gone, and its sockets with it.
		return root && peer ? { root, peer } : undefined;
	};

	return {
		async fetch(request, server) {
			const url = new URL(request.url);
			if (closed)
				return errorResponse(new CloudError("UNAVAILABLE", "Stopping"));
			if (url.pathname === "/health") return jsonResponse({ ok: true });
			// `/<project>/v1/…`, like the hosted service.
			const [, project = "", ...path] = url.pathname.split("/");
			if (!PROJECT.test(project))
				return errorResponse(new CloudError("NOT_FOUND", "Unknown project"));
			url.pathname = `/${path.join("/")}`;
			const routed = new Request(url, request);
			const route = await routeCloudRequest(routed, secrets);
			if (route.type === "response") return route.response;
			const root = open(project, route.root);
			return hold(root, async () => {
				if (route.type === "connect") {
					if (root.meter && !(await root.meter.connect(size(root, 1))))
						return errorResponse(
							new CloudError(
								"LIMIT_EXCEEDED",
								"The project reached its connection limit",
							),
						);
					const data: LocalCloudSocket = {
						id: crypto.randomUUID(),
						project,
						root: route.root,
						subject: route.subject,
						envelope: route.envelope,
					};
					// Rights are checked per document, so the client gets FORBIDDEN
					// rather than a failed upgrade whose status browsers hide.
					const upgraded = server.upgrade(request, {
						data,
						headers: {
							"Sec-WebSocket-Protocol": CLOUD_SUBPROTOCOLS[route.envelope],
						},
					});
					if (!upgraded) return new Response(null, { status: 400 });
					// Stay in memory until the socket opens; if it never does, the
					// timer cleans up as after a socket that closed.
					if (!root.peers.size && !root.timer) await rest(root);
					return undefined;
				}
				await root.meter?.request(() => size(root));
				const response = await root.engine.handleRequest(
					route.action,
					routed,
					route.caller,
				);
				if (!response.ok) return response;
				// A root nobody connects to expires too: count from now.
				if (route.action === "expire" && !root.peers.size) await rest(root);
				if (
					route.action === "documents" &&
					url.searchParams.get("docId") === route.root
				) {
					// The root document was deleted: its sessions are over. Its
					// file stays, so that its tombstone keeps the ID retired.
					const left = { ...size(root), connections: 0 };
					const peers = [...root.peers.values()];
					evict(root);
					for (const peer of peers)
						try {
							peer.close(1000, "Root deleted");
						} catch {
							// Already closing.
						}
					await root.meter?.settle(left);
				}
				return response;
			});
		},
		websocket: {
			open(socket) {
				if (closed) return socket.close(1001, "Stopping");
				const { id, project, subject, envelope } = socket.data;
				const root = open(project, socket.data.root);
				socket.send(
					welcomeMessage(
						{ backend: "local", id: instance, location: "local" },
						{ presence: true, subtrees: true },
					),
				);
				let presence = false;
				root.peers.set(id, {
					id,
					subject,
					envelope,
					get presence() {
						return presence;
					},
					usePresence: () => void (presence = true),
					// A root stays in memory while it has sockets: it keeps them itself.
					subscriptions: new Map(),
					keepSubscriptions: () => true,
					send: (data) => void socket.send(data),
					close: (code, reason) => socket.close(code, reason),
				});
			},
			message(socket, message) {
				const found = rootOf(socket);
				if (!found) return;
				const { root, peer } = found;
				const data =
					typeof message === "string" ? message : new Uint8Array(message);
				const { meter } = root;
				if (!meter) return void root.engine.receive(peer, data);
				// A meter may wait for its report: messages still reach the root in order.
				root.frames = root.frames
					.then(async () => {
						if (root.gone) return;
						const refusal =
							typeof data === "string"
								? undefined
								: await meter.frame(data, () => size(root));
						if (refusal) peer.send(refusal);
						else void root.engine.receive(peer, data);
					})
					.catch(console.error);
			},
			async close(socket) {
				const found = rootOf(socket);
				if (!found) return;
				const { root, peer } = found;
				root.peers.delete(peer.id);
				await hold(root, async () => {
					await root.engine.disconnect(peer);
					if (root.gone) return;
					await root.meter?.settle(size(root));
					if (!root.peers.size) await rest(root);
				});
			},
		},
		close() {
			closed = true;
			for (const root of [...roots.values()]) evict(root);
		},
	};
}

export type LocalCloudServerOptions = LocalCloudOptions & {
	/** Default 3345; 0 picks a free one. */
	port?: number;
	/** Default `127.0.0.1`: this machine only. */
	hostname?: string;
};

/** Serve a local Pulsify Cloud. A project's URL is `<url>/<project>`. */
export function startLocalCloud({
	port = 3345,
	hostname = "127.0.0.1",
	...options
}: LocalCloudServerOptions): { url: string; stop(): void } {
	const cloud = createLocalCloud(options);
	const server = Bun.serve({
		port,
		hostname,
		fetch: cloud.fetch,
		websocket: cloud.websocket,
	});
	return {
		url: `http://${hostname}:${server.port}`,
		stop() {
			// Databases first: the sockets that close then have nothing to write.
			cloud.close();
			server.stop(true);
		},
	};
}
