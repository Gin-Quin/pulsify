import {
	first,
	randomToken,
	serve,
	sha256,
	type DurableState,
} from "./durable.js";
import { ingestEvents, type PolarEnv, type PolarEvent } from "./polar.js";

export type Plan = "free" | "pro";
/** Per month for messages; at any time for connections and storage. */
export const PLANS = {
	free: { connections: 100, messages: 1_000_000, bytes: 1_000_000_000 },
	pro: { connections: 1_000, messages: 5_000_000, bytes: 10_000_000_000 },
} as const satisfies Record<Plan, object>;

/** What a root tells its project: messages since its last report, its size and its sockets. */
export type RootReport = {
	root: string;
	messages: number;
	bytes: number;
	connections: number;
};
/** The answer: may the root accept uploads, and one more socket? */
export type RootStatus = { writable: boolean; connectable: boolean };
export type ProjectConfig = { tokenSecret: string; apiKey: string; plan: Plan };
export type Dashboard = {
	project: string;
	email: string;
	plan: Plan;
	tokenSecret: string;
	apiKey: string;
	usage: { messages: number; bytes: number; connections: number };
	limits: (typeof PLANS)[Plan];
};

/** A root that has not reported for this long no longer counts its sockets. */
export const LIVE_MS = 60 * 60 * 1000;
/** How often pending messages are sent to Polar. */
const INGEST_EVERY_MS = 5 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

type Row = {
	project: string;
	email: string;
	token_secret: string;
	api_key: string;
	plan: Plan;
	month: string;
	messages: number;
	bytes: number;
	pending: number;
	storage_day: string | null;
};

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS project (
 id INTEGER PRIMARY KEY CHECK(id = 1), project TEXT NOT NULL, email TEXT NOT NULL,
 token_secret TEXT NOT NULL, api_key TEXT NOT NULL, plan TEXT NOT NULL,
 month TEXT NOT NULL, messages INTEGER NOT NULL, bytes INTEGER NOT NULL,
 pending INTEGER NOT NULL, storage_day TEXT)`,
	`CREATE TABLE IF NOT EXISTS roots (
 root TEXT PRIMARY KEY, bytes INTEGER NOT NULL, connections INTEGER NOT NULL,
 seen_at INTEGER NOT NULL) WITHOUT ROWID`,
	"CREATE INDEX IF NOT EXISTS live_roots ON roots(seen_at) WHERE connections > 0",
	"CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID",
];

const month = (now: number) => new Date(now).toISOString().slice(0, 7);
const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const tokenSecret = () => randomToken(36);
const apiKey = () => `pk_${randomToken(32)}`;

/**
 * One per customer project: its secrets, its plan, its usage. Roots report to
 * it; it answers whether they may write and accept sockets, and sends Pro
 * usage to Polar.
 */
export class PulsifyProject {
	static readonly methods = [
		"create",
		"config",
		"report",
		"startSession",
		"checkSession",
		"endSession",
		"dashboard",
		"rotate",
		"setPlan",
	] as const;

	constructor(
		private readonly state: DurableState,
		private readonly env: PolarEnv,
	) {
		for (const statement of SCHEMA) state.storage.sql.exec(statement);
	}

	fetch(request: Request): Promise<Response> {
		return serve(this, PulsifyProject.methods, request);
	}

	private exec(query: string, ...bindings: unknown[]) {
		return this.state.storage.sql.exec(query, ...bindings);
	}

	private row(): Row | undefined {
		const row = first<Row>(this.exec("SELECT * FROM project"));
		if (row && row.month !== month(Date.now())) {
			this.exec(
				"UPDATE project SET month = ?, messages = 0",
				month(Date.now()),
			);
			return { ...row, month: month(Date.now()), messages: 0 };
		}
		return row;
	}

	create(project: string, email: string): void {
		this.exec(
			"INSERT OR IGNORE INTO project VALUES (1, ?, ?, ?, ?, 'free', ?, 0, 0, 0, NULL)",
			project,
			email,
			tokenSecret(),
			apiKey(),
			month(Date.now()),
		);
	}

	config(): ProjectConfig | null {
		const row = this.row();
		return row
			? { tokenSecret: row.token_secret, apiKey: row.api_key, plan: row.plan }
			: null;
	}

	private liveConnections(now: number): number {
		return Number(
			first<{ live: number }>(
				this.exec(
					"SELECT COALESCE(SUM(connections), 0) AS live FROM roots WHERE connections > 0 AND seen_at > ?",
					now - LIVE_MS,
				),
			)!.live,
		);
	}

	async report(report: RootReport): Promise<RootStatus> {
		const row = this.row();
		if (!row) return { writable: false, connectable: false };
		const now = Date.now();
		const previous = first<{ bytes: number }>(
			this.exec("SELECT bytes FROM roots WHERE root = ?", report.root),
		);
		const bytes = row.bytes - (previous?.bytes ?? 0) + report.bytes;
		const messages = row.messages + report.messages;
		this.exec(
			"INSERT OR REPLACE INTO roots VALUES (?, ?, ?, ?)",
			report.root,
			report.bytes,
			report.connections,
			now,
		);
		// Only Pro usage is billed; Free stops at its limits instead.
		const pending = row.plan === "pro" ? row.pending + report.messages : 0;
		this.exec(
			"UPDATE project SET messages = ?, bytes = ?, pending = ?",
			messages,
			bytes,
			pending,
		);
		const alarm = await this.state.storage.getAlarm();
		if (pending && (alarm === null || alarm > now + INGEST_EVERY_MS))
			await this.state.storage.setAlarm(now + INGEST_EVERY_MS);
		const limits = PLANS[row.plan];
		return {
			writable:
				row.plan === "pro" ||
				(messages < limits.messages && bytes < limits.bytes),
			connectable: this.liveConnections(now) <= limits.connections,
		};
	}

	async startSession(): Promise<string> {
		const secret = randomToken();
		const now = Date.now();
		this.exec("DELETE FROM sessions WHERE expires_at < ?", now);
		this.exec(
			"INSERT INTO sessions VALUES (?, ?)",
			await sha256(secret),
			now + SESSION_MS,
		);
		return secret;
	}

	async checkSession(secret: string): Promise<boolean> {
		return !!first(
			this.exec(
				"SELECT 1 FROM sessions WHERE hash = ? AND expires_at > ?",
				await sha256(secret),
				Date.now(),
			),
		);
	}

	async endSession(secret: string): Promise<void> {
		this.exec("DELETE FROM sessions WHERE hash = ?", await sha256(secret));
	}

	dashboard(): Dashboard | null {
		const row = this.row();
		if (!row) return null;
		return {
			project: row.project,
			email: row.email,
			plan: row.plan,
			tokenSecret: row.token_secret,
			apiKey: row.api_key,
			usage: {
				messages: row.messages,
				bytes: row.bytes,
				connections: this.liveConnections(Date.now()),
			},
			limits: PLANS[row.plan],
		};
	}

	/** A new secret replaces the old one at once; gateways pick it up within a minute. */
	rotate(secret: "token" | "api"): Dashboard | null {
		if (secret === "token")
			this.exec("UPDATE project SET token_secret = ?", tokenSecret());
		else this.exec("UPDATE project SET api_key = ?", apiKey());
		return this.dashboard();
	}

	async setPlan(plan: Plan): Promise<void> {
		const row = this.row();
		if (!row || row.plan === plan) return;
		// Bill what was used on Pro before leaving it.
		if (row.plan === "pro") await this.alarm();
		this.exec(
			"UPDATE project SET plan = ?, pending = 0, storage_day = NULL",
			plan,
		);
		// Pro: send today's storage now, then once a day.
		if (plan === "pro") await this.state.storage.setAlarm(Date.now());
	}

	/** Pro only: send pending messages, and the stored size once a day. */
	async alarm(): Promise<void> {
		const row = this.row();
		if (!row || row.plan !== "pro") return;
		const now = Date.now();
		const events: PolarEvent[] = [];
		if (row.pending)
			events.push({
				name: "cloud.messages",
				external_customer_id: row.project,
				metadata: { count: row.pending },
			});
		if (row.storage_day !== day(now))
			events.push({
				name: "cloud.storage",
				external_customer_id: row.project,
				metadata: { gb_days: row.bytes / 1e9 },
				external_id: `${row.project}:storage:${day(now)}`,
			});
		if (events.length) {
			// ponytail: a lost response re-sends the messages once; external IDs if that matters.
			await ingestEvents(this.env, events); // throws: the runtime retries the alarm
			// Reports may have arrived while Polar answered.
			this.exec(
				"UPDATE project SET pending = pending - ?, storage_day = ?",
				row.pending,
				day(now),
			);
		}
		const midnight = Date.parse(`${day(now)}T00:00:00Z`) + 86_400_000;
		const pending = first<{ pending: number }>(
			this.exec("SELECT pending FROM project"),
		)!.pending;
		await this.state.storage.setAlarm(
			pending ? Math.min(now + INGEST_EVERY_MS, midnight) : midnight,
		);
	}
}
