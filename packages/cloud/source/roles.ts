import { CloudError } from "./errors.js";
import { assertDocumentOf, covers } from "./ids.js";

/**
 * `reader` downloads, `editor` also uploads and creates documents, `owner`
 * also manages the grants of its subtree through the HTTP API.
 */
export type CloudRole = "reader" | "editor" | "owner";
export const CLOUD_ROLES: readonly CloudRole[] = ["reader", "editor", "owner"];
/** A grant to this subject applies to every authenticated user. */
export const ANY_SUBJECT = "*";
export const MAX_SUBJECT_LENGTH = 256;
export const MAX_GRANTS_PER_ROOT = 10_000;

/** One row of a root's access table: `subject` has `role` on `prefix` and below. */
export type CloudGrant = {
	readonly subject: string;
	readonly prefix: string;
	readonly role: CloudRole;
};

const rank: Readonly<Record<CloudRole, number>> = {
	reader: 1,
	editor: 2,
	owner: 3,
};

export function isCloudRole(value: unknown): value is CloudRole {
	return value === "reader" || value === "editor" || value === "owner";
}
export const canWrite = (role: CloudRole | undefined): boolean =>
	!!role && rank[role] >= rank.editor;
export const canManage = (role: CloudRole | undefined): boolean =>
	role === "owner";

/**
 * The strongest role granted to `subject` (or to everyone) on `docId` or one
 * of its ancestors. Grants only add access; a child cannot remove a parent's.
 */
export function roleFor(
	grants: Iterable<CloudGrant>,
	subject: string,
	docId: string,
): CloudRole | undefined {
	let role: CloudRole | undefined;
	for (const grant of grants)
		if (
			(grant.subject === subject || grant.subject === ANY_SUBJECT) &&
			covers(grant.prefix, docId) &&
			(!role || rank[grant.role] > rank[role])
		)
			role = grant.role;
	return role;
}

export function assertSubject(subject: unknown): asserts subject is string {
	if (
		typeof subject !== "string" ||
		!subject.length ||
		subject.length > MAX_SUBJECT_LENGTH ||
		!subject.isWellFormed() ||
		subject.includes("\0")
	)
		throw new CloudError("BAD_REQUEST", "Invalid subject");
}

/** Validate an untrusted grant for `root`; returns a normalized copy. */
export function parseGrant(root: string, input: unknown): CloudGrant {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		throw new CloudError("BAD_REQUEST", "Expected a grant object");
	const { subject, prefix, role } = input as Record<string, unknown>;
	assertSubject(subject);
	assertDocumentOf(root, prefix);
	if (!isCloudRole(role))
		throw new CloudError(
			"BAD_REQUEST",
			`Role must be one of ${CLOUD_ROLES.join(", ")}`,
		);
	return { subject, prefix, role };
}

export function compareGrants(a: CloudGrant, b: CloudGrant): number {
	return a.prefix < b.prefix
		? -1
		: a.prefix > b.prefix
			? 1
			: a.subject < b.subject
				? -1
				: a.subject > b.subject
					? 1
					: 0;
}
