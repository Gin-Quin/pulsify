import {
	first,
	randomToken,
	serve,
	sha256,
	type DurableState,
} from "./durable.js";

const LINK_MS = 15 * 60 * 1000;
const RESEND_MS = 60 * 1000;

type Row = {
	project: string;
	link_hash: string | null;
	link_expires_at: number;
	sent_at: number;
};

const projectId = () =>
	Array.from(
		crypto.getRandomValues(new Uint8Array(16)),
		(byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31],
	).join("");

/** One per email address: the project it owns and its pending login link. */
export class PulsifyAccount {
	static readonly methods = ["login", "verify"] as const;

	constructor(private readonly state: DurableState) {
		state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS account (
 id INTEGER PRIMARY KEY CHECK(id = 1), project TEXT NOT NULL,
 link_hash TEXT, link_expires_at INTEGER NOT NULL, sent_at INTEGER NOT NULL)`);
	}

	fetch(request: Request): Promise<Response> {
		return serve(this, PulsifyAccount.methods, request);
	}

	/** A new login link token, or null when one was sent less than a minute ago. */
	async login(): Promise<string | null> {
		const now = Date.now();
		const row = first<Row>(
			this.state.storage.sql.exec("SELECT * FROM account"),
		);
		if (row && now - row.sent_at < RESEND_MS) return null;
		const token = randomToken();
		this.state.storage.sql.exec(
			"INSERT OR REPLACE INTO account VALUES (1, ?, ?, ?, ?)",
			row?.project ?? projectId(),
			await sha256(token),
			now + LINK_MS,
			now,
		);
		return token;
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
}
