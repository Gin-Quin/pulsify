import {
	SqlitePatchStore,
	type PatchStore,
	type SqliteConnection,
} from "@pulsify/core/storage";
import { isCloudRole, type CloudGrant, type CloudRole } from "@pulsify/cloud";

/** A connection's subscription to one document, with the role it was told. */
export type CloudSubscription = {
	readonly connection: string;
	readonly docId: string;
	readonly role: CloudRole;
};
export type CloudUsage = { documents: number; rows: number; bytes: number };

/**
 * Everything one root persists. Patch rows use the shared Pulsify stores;
 * grants are the root's access table. Subscriptions only need to survive a
 * host that evicts the root while its sockets stay open (Durable Object
 * hibernation); other hosts may keep them in memory.
 */
export interface CloudRootStorage {
	readonly patches: PatchStore;
	loadGrants(): Promise<CloudGrant[]>;
	putGrant(grant: CloudGrant): Promise<void>;
	deleteGrant(subject: string, prefix: string): Promise<boolean>;
	loadSubscriptions(): Promise<CloudSubscription[]>;
	saveSubscription(subscription: CloudSubscription): Promise<void>;
	deleteSubscription(connection: string, docId: string): Promise<void>;
	deleteConnection(connection: string): Promise<void>;
	usage(): Promise<CloudUsage>;
}

/** Tables added next to the patch schema in a root's own SQLite database. */
export const CLOUD_SQLITE_SCHEMA: string = `
CREATE TABLE IF NOT EXISTS pulsify_cloud_grants (
 subject TEXT NOT NULL, prefix TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('reader','editor','owner')),
 PRIMARY KEY(subject, prefix)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pulsify_cloud_subscriptions (
 connection TEXT NOT NULL, doc_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('reader','editor','owner')),
 PRIMARY KEY(connection, doc_id)
) WITHOUT ROWID;
`;

/** One SQLite database per root, as in a Durable Object. */
export class SqliteCloudStorage implements CloudRootStorage {
	readonly patches: SqlitePatchStore;
	constructor(private readonly db: SqliteConnection) {
		this.patches = new SqlitePatchStore(db);
		db.exec(CLOUD_SQLITE_SCHEMA);
	}
	async loadGrants(): Promise<CloudGrant[]> {
		return (
			this.db
				.query("SELECT subject, prefix, role FROM pulsify_cloud_grants")
				.all() as CloudGrant[]
		).filter((grant) => isCloudRole(grant.role));
	}
	async putGrant(grant: CloudGrant): Promise<void> {
		this.db
			.query(
				"INSERT INTO pulsify_cloud_grants(subject, prefix, role) VALUES(?, ?, ?) ON CONFLICT(subject, prefix) DO UPDATE SET role = excluded.role",
			)
			.run(grant.subject, grant.prefix, grant.role);
	}
	async deleteGrant(subject: string, prefix: string): Promise<boolean> {
		const existing = this.db
			.query(
				"SELECT 1 AS found FROM pulsify_cloud_grants WHERE subject = ? AND prefix = ?",
			)
			.get(subject, prefix);
		if (!existing) return false;
		this.db
			.query(
				"DELETE FROM pulsify_cloud_grants WHERE subject = ? AND prefix = ?",
			)
			.run(subject, prefix);
		return true;
	}
	async loadSubscriptions(): Promise<CloudSubscription[]> {
		return (
			this.db
				.query(
					"SELECT connection, doc_id, role FROM pulsify_cloud_subscriptions",
				)
				.all() as { connection: string; doc_id: string; role: CloudRole }[]
		).map(({ connection, doc_id, role }) => ({
			connection,
			docId: doc_id,
			role,
		}));
	}
	async saveSubscription({
		connection,
		docId,
		role,
	}: CloudSubscription): Promise<void> {
		this.db
			.query(
				"INSERT INTO pulsify_cloud_subscriptions(connection, doc_id, role) VALUES(?, ?, ?) ON CONFLICT(connection, doc_id) DO UPDATE SET role = excluded.role",
			)
			.run(connection, docId, role);
	}
	async deleteSubscription(connection: string, docId: string): Promise<void> {
		this.db
			.query(
				"DELETE FROM pulsify_cloud_subscriptions WHERE connection = ? AND doc_id = ?",
			)
			.run(connection, docId);
	}
	async deleteConnection(connection: string): Promise<void> {
		this.db
			.query("DELETE FROM pulsify_cloud_subscriptions WHERE connection = ?")
			.run(connection);
	}
	async usage(): Promise<CloudUsage> {
		const row = this.db
			.query(
				"SELECT COUNT(DISTINCT doc_id) AS documents, COUNT(*) AS rows, COALESCE(SUM(length(operations)), 0) AS bytes FROM pulsify_op_rows",
			)
			.get() as { documents: number; rows: number; bytes: number };
		return {
			documents: Number(row.documents),
			rows: Number(row.rows),
			bytes: Number(row.bytes),
		};
	}
}
