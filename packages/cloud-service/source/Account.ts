import {
	first,
	randomToken,
	serve,
	sha256,
	type DurableState,
} from "./durable.js";

const LINK_MS = 15 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Wrong codes an address accepts a day, across new codes: a 6-digit code is guessable. */
const CODE_FAILURES = 20;

type Row = {
	project: string;
	link_hash: string | null;
	link_expires_at: number;
	sent_at: number;
	code_hash: string | null;
	code_failures: number;
	failures_since: number;
};

const projectId = () =>
	Array.from(
		crypto.getRandomValues(new Uint8Array(16)),
		(byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31],
	).join("");

const loginCode = () =>
	String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(
		6,
		"0",
	);

/** One per email address: the project it owns and its pending login link and code. */
export class PulsifyAccount {
	static readonly methods = [
		"login",
		"verify",
		"verifyCode",
		"delete",
	] as const;

	constructor(private readonly state: DurableState) {
		state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS account (
 id INTEGER PRIMARY KEY CHECK(id = 1), project TEXT NOT NULL,
 link_hash TEXT, link_expires_at INTEGER NOT NULL, sent_at INTEGER NOT NULL)`);
		// Accounts created before login codes lack their columns.
		const columns = state.storage.sql
			.exec("PRAGMA table_info(account)")
			.toArray()
			.map((column) => column["name"]);
		if (!columns.includes("code_hash"))
			for (const column of [
				"code_hash TEXT",
				"code_failures INTEGER NOT NULL DEFAULT 0",
				"failures_since INTEGER NOT NULL DEFAULT 0",
			])
				state.storage.sql.exec(`ALTER TABLE account ADD COLUMN ${column}`);
	}

	fetch(request: Request): Promise<Response> {
		return serve(this, PulsifyAccount.methods, request);
	}

	/** A new login link token and code, or null when one was sent less than a minute ago. */
	async login(): Promise<{ token: string; code: string } | null> {
		const now = Date.now();
		const row = first<Row>(
			this.state.storage.sql.exec("SELECT * FROM account"),
		);
		if (row && now - row.sent_at < RESEND_MS) return null;
		const token = randomToken();
		const code = loginCode();
		this.state.storage.sql.exec(
			`INSERT OR REPLACE INTO account (id, project, link_hash, link_expires_at,
 sent_at, code_hash, code_failures, failures_since) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
			row?.project ?? projectId(),
			await sha256(token),
			now + LINK_MS,
			now,
			await sha256(code),
			row?.code_failures ?? 0,
			row?.failures_since ?? 0,
		);
		return { token, code };
	}

	/** Forgets the address: its project, link and code. Its next sign-in starts a new project. */
	delete(): void {
		this.state.storage.sql.exec("DELETE FROM account");
	}

	/**
	 * The project of a valid link. A link works until it expires, not once:
	 * mail scanners open links before people do.
	 */
	async verify(token: string): Promise<string | null> {
		const row = first<Row>(
			this.state.storage.sql.exec("SELECT * FROM account"),
		);
		if (!row?.link_hash || row.link_expires_at < Date.now()) return null;
		return row.link_hash === (await sha256(String(token))) ? row.project : null;
	}

	/**
	 * The project of a valid code, typed in the dashboard. `anyCode` is the
	 * local service's fixed code: it signs in an address that asked for one.
	 */
	async verifyCode(code: string, anyCode = false): Promise<string | null> {
		const row = first<Row>(
			this.state.storage.sql.exec("SELECT * FROM account"),
		);
		if (!row) return null;
		if (anyCode) return row.project;
		const now = Date.now();
		const failures = now - row.failures_since < DAY_MS ? row.code_failures : 0;
		if (!row.code_hash || row.link_expires_at < now) return null;
		if (failures >= CODE_FAILURES) return null;
		if (row.code_hash === (await sha256(String(code)))) return row.project;
		this.state.storage.sql.exec(
			"UPDATE account SET code_failures = ?, failures_since = ?",
			failures + 1,
			failures ? row.failures_since : now,
		);
		return null;
	}
}
