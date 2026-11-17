/**
 * The project of `email` on the local Pulsify Cloud (`bun run dev:service`),
 * created on first sign-in. The local service signs in any address that asked
 * for a code with 444444.
 */
export async function localCloudProject(
	email: string,
	service = "http://localhost:8787",
): Promise<{ url: string; apiKey: string; tokenSecret: string }> {
	const headers = {
		"Content-Type": "application/json",
		Origin: "http://localhost:3000",
	};
	await fetch(`${service}/account/login`, {
		method: "POST",
		headers,
		body: JSON.stringify({ email }),
	}).catch(() => {
		throw new Error(
			`No local Pulsify Cloud at ${service}: bun run dev:service`,
		);
	});
	const signIn = await fetch(`${service}/account/code`, {
		method: "POST",
		headers,
		body: JSON.stringify({ email, code: "444444" }),
	});
	const cookie = signIn.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error(`Sign-in failed: ${await signIn.text()}`);
	const { url, apiKey, tokenSecret } = (await (
		await fetch(`${service}/account/`, { headers: { Cookie: cookie } })
	).json()) as Record<string, string>;
	if (!url || !apiKey || !tokenSecret)
		throw new Error(`No project for ${email} on ${service}`);
	return { url, apiKey, tokenSecret };
}
