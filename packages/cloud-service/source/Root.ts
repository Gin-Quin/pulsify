import { CloudError, peekFrameHeader } from "pulsify-cloud";
import { errorResponse } from "pulsify-cloud-server";
import {
	PulsifyCloudRoot,
	ROOT_HEADERS,
	type DurableObjectStateLike,
	type PulsifyCloudRootEnv,
} from "pulsify-cloud-server/cloudflare";
import { encodeMessage, PRESENCE_KIND } from "pulsify-core/protocol";
import { call, first, type DurableNamespace } from "./durable.js";
import type { RootReport, RootStatus } from "./Project.js";

/** Set by the gateway on every request it forwards to a root. */
export const PROJECT_HEADER = "x-pulsify-project";
/** How often an active root reports its usage to its project. */
export const REPORT_EVERY_MS = 30_000;

type RootState = DurableObjectStateLike & {
	storage: DurableObjectStateLike["storage"] & {
		sql: { databaseSize: number };
	};
};
export type RootEnv = PulsifyCloudRootEnv & { PROJECTS: DurableNamespace };

/**
 * A Pulsify Cloud root that belongs to a customer project: it counts the
 * frames clients send (presence aside), refuses uploads once a Free project is
 * over its limits, and sockets over the plan's connection limit.
 */
export class PulsifyRoot extends PulsifyCloudRoot {
	private pending = 0;
	private reportedAt = 0;
	private writable = true;
	private names: { project: string; root: string } | undefined;

	constructor(
		private readonly durable: RootState,
		private readonly env: RootEnv,
	) {
		super(durable, env);
		durable.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS pulsify_service (project TEXT NOT NULL, root TEXT NOT NULL)",
		);
	}

	override async fetch(request: Request): Promise<Response> {
		const project = request.headers.get(PROJECT_HEADER);
		const root = decodeURIComponent(
			request.headers.get(ROOT_HEADERS.root) ?? "",
		);
		if (project && root && !this.identity()) {
			this.durable.storage.sql.exec(
				"INSERT INTO pulsify_service VALUES (?, ?)",
				project,
				root,
			);
			this.names = { project, root };
		}
		if (request.headers.get(ROOT_HEADERS.action) === "connect") {
			const { connectable } = await this.report(1);
			if (!connectable)
				return errorResponse(
					new CloudError(
						"LIMIT_EXCEEDED",
						"The project reached its plan's connection limit",
					),
				);
		}
		return super.fetch(request);
	}

	override async webSocketMessage(
		socket: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		if (typeof message !== "string") {
			let header: ReturnType<typeof peekFrameHeader> | undefined;
			try {
				header = peekFrameHeader(new Uint8Array(message));
			} catch {
				// Invalid: the root closes the socket.
			}
			if (header && header.kind !== PRESENCE_KIND) {
				this.pending++;
				if (!this.reportedAt || Date.now() - this.reportedAt >= REPORT_EVERY_MS)
					await this.report(0);
				// kind 3 is syncBack, 4 an update: the uploads.
				if (!this.writable && (header.kind === 3 || header.kind === 4)) {
					socket.send(
						encodeMessage({
							kind: 6,
							docId: header.docId,
							requestId: header.requestId,
							code: "LIMIT_EXCEEDED",
							message: "The project reached its Free plan limits",
						}) as Uint8Array<ArrayBuffer>,
					);
					return;
				}
			}
		}
		await super.webSocketMessage(socket, message);
	}

	override async webSocketClose(
		socket: WebSocket,
		code: number,
		reason: string,
	): Promise<void> {
		await super.webSocketClose(socket, code, reason);
		// The runtime still lists the socket that is closing.
		await this.report(-1);
	}

	override async webSocketError(socket: WebSocket): Promise<void> {
		await super.webSocketError(socket);
		await this.report(-1);
	}

	private identity() {
		return (this.names ??= first<{ project: string; root: string }>(
			this.durable.storage.sql.exec(
				"SELECT project, root FROM pulsify_service",
			),
		));
	}

	/** Send the counted frames, this root's size and sockets; learn what it may do. */
	private async report(sockets: number): Promise<RootStatus> {
		const names = this.identity();
		if (!names) return { writable: true, connectable: true };
		const messages = this.pending;
		this.pending = 0;
		this.reportedAt = Date.now();
		const report: RootReport = {
			root: names.root,
			messages,
			bytes: this.durable.storage.sql.databaseSize,
			connections: Math.max(0, this.durable.getWebSockets().length + sockets),
		};
		try {
			const status = await call<RootStatus>(
				this.env.PROJECTS.get(this.env.PROJECTS.idFromName(names.project)),
				"report",
				report,
			);
			this.writable = status.writable;
			return status;
		} catch {
			// The project is unreachable: count again next time, keep serving.
			this.pending += messages;
			return { writable: this.writable, connectable: true };
		}
	}
}
