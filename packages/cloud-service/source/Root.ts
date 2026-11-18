import { CloudError } from "pulsify-cloud";
import { errorResponse, type CloudRootSize } from "pulsify-cloud-server";
import {
	PulsifyCloudRoot,
	ROOT_HEADERS,
	type DurableObjectStateLike,
	type PulsifyCloudRootEnv,
} from "pulsify-cloud-server/cloudflare";
import { call, first, type DurableNamespace } from "./durable.js";
import { RootMeter } from "./meter.js";
import { PURGE_ACTION, type RootStatus } from "./Project.js";

/** Set by the gateway on every request it forwards to a root. */
export const PROJECT_HEADER = "x-pulsify-project";

type RootState = DurableObjectStateLike & {
	storage: DurableObjectStateLike["storage"] & {
		sql: { databaseSize: number };
	};
};
export type RootEnv = PulsifyCloudRootEnv & { PROJECTS: DurableNamespace };

/**
 * A Pulsify Cloud root that belongs to a customer project, on Cloudflare. It
 * remembers its project, hands the root's sockets, requests and frames to a
 * `RootMeter`, which knows nothing of Durable Objects, and wipes itself when
 * the project is deleted.
 */
export class PulsifyRoot extends PulsifyCloudRoot {
	private metering: RootMeter | undefined;
	private names: { project: string; root: string } | undefined;
	/** The project was deleted: the tables are gone until this object restarts. */
	private purged = false;

	constructor(
		private readonly durable: RootState,
		private readonly env: RootEnv,
	) {
		super(durable, env);
	}

	override async fetch(request: Request): Promise<Response> {
		const action = request.headers.get(ROOT_HEADERS.action);
		if (action === PURGE_ACTION) return this.purge();
		if (this.purged)
			return errorResponse(new CloudError("NOT_FOUND", "Unknown project"));
		const project = request.headers.get(PROJECT_HEADER);
		const root = decodeURIComponent(
			request.headers.get(ROOT_HEADERS.root) ?? "",
		);
		if (project && root && !this.identity()) {
			// Created here, not on wake: a deleted root must stay without storage.
			this.durable.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS pulsify_service (project TEXT NOT NULL, root TEXT NOT NULL)",
			);
			this.durable.storage.sql.exec(
				"INSERT INTO pulsify_service VALUES (?, ?)",
				project,
				root,
			);
			this.names = { project, root };
		}
		const meter = this.meter();
		if (action !== "connect") await meter?.request(() => this.size());
		// The socket that asks to open is not accepted yet.
		else if (meter && !(await meter.connect(this.size(1))))
			return errorResponse(
				new CloudError(
					"LIMIT_EXCEEDED",
					"The project reached its plan's connection limit",
				),
			);
		return super.fetch(request);
	}

	/** The project was deleted: close the sockets and wipe every table. */
	private async purge(): Promise<Response> {
		this.purged = true;
		for (const socket of this.durable.getWebSockets())
			socket.close(1008, "Project deleted");
		await this.durable.storage.deleteAlarm();
		await this.durable.storage.deleteAll();
		return new Response(null, { status: 204 });
	}

	override async webSocketMessage(
		socket: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		if (this.purged) return;
		if (typeof message !== "string") {
			const refusal = await this.meter()?.frame(new Uint8Array(message), () =>
				this.size(),
			);
			if (refusal) {
				socket.send(refusal as Uint8Array<ArrayBuffer>);
				return;
			}
		}
		await super.webSocketMessage(socket, message);
	}

	override async webSocketClose(
		socket: WebSocket,
		code: number,
		reason: string,
	): Promise<void> {
		if (this.purged) return;
		await super.webSocketClose(socket, code, reason);
		// The runtime still lists the socket that is closing.
		await this.meter()?.settle(this.size(-1));
	}

	override async webSocketError(socket: WebSocket): Promise<void> {
		if (this.purged) return;
		await super.webSocketError(socket);
		await this.meter()?.settle(this.size(-1));
	}

	/** The root document was deleted: report the root without sockets, then forget it. */
	protected override async erase(): Promise<void> {
		await super.erase();
		await this.meter()?.settle({ ...this.size(), connections: 0 });
		this.names = this.metering = undefined;
	}

	/** Expired or empty, the root is wiped: the project stops counting it. */
	protected override async wipe(): Promise<void> {
		// Before the wipe: it deletes the table that names the project.
		const meter = this.meter();
		await super.wipe();
		this.names = this.metering = undefined;
		await meter?.settle({ bytes: 0, connections: 0 });
	}

	private identity() {
		try {
			return (this.names ??= first<{ project: string; root: string }>(
				this.durable.storage.sql.exec(
					"SELECT project, root FROM pulsify_service",
				),
			));
		} catch {
			// No table: the root has not served a request since it was created or deleted.
			return undefined;
		}
	}

	/** What this root measures, with `sockets` more or fewer than the runtime lists. */
	private size(sockets = 0): CloudRootSize {
		return {
			bytes: this.durable.storage.sql.databaseSize,
			connections: Math.max(0, this.durable.getWebSockets().length + sockets),
		};
	}

	/** The meter of this root, once it knows its project. */
	private meter(): RootMeter | undefined {
		if (this.metering) return this.metering;
		const names = this.identity();
		if (!names) return undefined;
		const project = this.env.PROJECTS.get(
			this.env.PROJECTS.idFromName(names.project),
		);
		return (this.metering = new RootMeter(names.root, (report) =>
			call<RootStatus>(project, "report", report),
		));
	}
}
