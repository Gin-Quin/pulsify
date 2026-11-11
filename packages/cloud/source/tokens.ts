import { jwtVerify, SignJWT } from "jose";
import { CloudError } from "./errors.js";
import { ANY_SUBJECT, assertSubject } from "./roles.js";

/** Tokens identify a user; their rights live in each root's grant table. */
export const CLOUD_TOKEN_AUDIENCE = "pulsify-cloud";
export type CloudTokenClaims = { subject: string };

const key = (secret: string) => {
	if (secret.length < 32)
		throw new TypeError("The token secret needs at least 32 characters");
	return new TextEncoder().encode(secret);
};

/**
 * Sign a short-lived HS256 identity token in your backend, after your own
 * login. The cloud verifies it with the same secret.
 */
export function signCloudToken(
	claims: CloudTokenClaims,
	secret: string,
	options: { expiresIn?: string | number } = {},
): Promise<string> {
	assertSubject(claims.subject);
	if (claims.subject === ANY_SUBJECT)
		throw new TypeError(`"${ANY_SUBJECT}" is reserved for grants`);
	return new SignJWT({})
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setSubject(claims.subject)
		.setAudience(CLOUD_TOKEN_AUDIENCE)
		.setIssuedAt()
		.setExpirationTime(options.expiresIn ?? "1h")
		.sign(key(secret));
}

export async function verifyCloudToken(
	token: string,
	secret: string,
): Promise<CloudTokenClaims> {
	let subject: unknown;
	try {
		({
			payload: { sub: subject },
		} = await jwtVerify(token, key(secret), {
			algorithms: ["HS256"],
			audience: CLOUD_TOKEN_AUDIENCE,
			requiredClaims: ["exp", "sub"],
		}));
	} catch (cause) {
		throw new CloudError("UNAUTHORIZED", "Invalid or expired token", { cause });
	}
	try {
		assertSubject(subject);
	} catch {
		throw new CloudError("UNAUTHORIZED", "Invalid token subject");
	}
	if (subject === ANY_SUBJECT)
		throw new CloudError("UNAUTHORIZED", "Invalid token subject");
	return { subject };
}
