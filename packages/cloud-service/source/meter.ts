import { peekFrameHeader } from "pulsify-cloud";
import type { CloudMeter, CloudRootSize } from "pulsify-cloud-server";
import { encodeMessage, PRESENCE_KIND } from "pulsify-core/protocol";
import type { RootReport, RootStatus } from "./Project.js";

/** How often an active root reports its usage to its project. */
export const REPORT_EVERY_MS = 30_000;

/**
 * What makes a root belong to a customer project, on any host: it counts the
 * frames clients send (presence aside) and reports them to the project with
 * the root's size and sockets, refuses uploads once a Free project is over its
 * limits, and sockets over the plan's connection limit.
 */
export class RootMeter implements CloudMeter {
	private pending = 0;
	private reportedAt = 0;
	private writable = true;

	constructor(
		private readonly root: string,
		/** Reaches the project; rejects when it cannot. */
		private readonly send: (report: RootReport) => Promise<RootStatus>,
	) {}

	async connect(size: CloudRootSize): Promise<boolean> {
		return (await this.report(size)).connectable;
	}

	/** A root used only over HTTP reports too: the project lists every root it must delete. */
	async request(size: () => CloudRootSize): Promise<void> {
		if (!this.reportedAt) await this.report(size());
	}

	async frame(
		data: Uint8Array,
		size: () => CloudRootSize,
	): Promise<Uint8Array | undefined> {
		let header: ReturnType<typeof peekFrameHeader>;
		try {
			header = peekFrameHeader(data);
		} catch {
			// Invalid: the root closes the socket.
			return undefined;
		}
		if (header.kind === PRESENCE_KIND) return undefined;
		this.pending++;
		if (!this.reportedAt || Date.now() - this.reportedAt >= REPORT_EVERY_MS)
			await this.report(size());
		// kind 3 is syncBack, 4 an update: the uploads.
		if (this.writable || (header.kind !== 3 && header.kind !== 4))
			return undefined;
		return encodeMessage({
			kind: 6,
			docId: header.docId,
			requestId: header.requestId,
			code: "LIMIT_EXCEEDED",
			message: "The project reached its Free plan limits",
		});
	}

	async settle(size: CloudRootSize): Promise<void> {
		await this.report(size);
	}

	/** Send the counted frames, the root's size and sockets; learn what it may do. */
	private async report(size: CloudRootSize): Promise<RootStatus> {
		const messages = this.pending;
		this.pending = 0;
		this.reportedAt = Date.now();
		try {
			const status = await this.send({ root: this.root, messages, ...size });
			this.writable = status.writable;
			return status;
		} catch {
			// The project is unreachable: count again next time, keep serving.
			this.pending += messages;
			return { writable: this.writable, connectable: true };
		}
	}
}
