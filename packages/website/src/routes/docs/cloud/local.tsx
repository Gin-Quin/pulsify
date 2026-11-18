import { Seo } from "~/components/Seo";
import { CodeBlock } from "~/components/CodeBlock";

const local = `bun add -d pulsify-cloud-server
bun run pulsify dev              # on port 3345, or --port 4000`;

const localEnvironment = `# What pulsify dev prints: the three values of the dashboard, for your machine.
PULSIFY_URL=http://127.0.0.1:3345/dev
PULSIFY_TOKEN_SECRET=pulsify-dev-token-secret-not-for-production
PULSIFY_API_KEY=pk_pulsify-dev-api-key-not-for-production`;

const localSecrets = `PULSIFY_TOKEN_SECRET=… PULSIFY_API_KEY=… bun run pulsify dev`;

export default function CloudLocal() {
	return (
		<>
			<Seo
				title="Local development · Pulsify Docs"
				description="pulsify dev runs Pulsify Cloud on your machine: the same server and API as your project, one SQLite file per root, no account and no network."
			/>
			<h1>Local development</h1>
			<p>
				<code>pulsify dev</code> runs Pulsify Cloud on your machine: the same
				server and the same API as your project, with no account and no network.
				It needs <a href="https://bun.sh">Bun</a>.
			</p>
			<CodeBlock title="terminal" code={local} />

			<h2>URL and secrets</h2>
			<p>
				It prints the URL and the two secrets of a local project. Give them to
				your app in development, where it reads those of the{" "}
				<a href="/dashboard">dashboard</a> in production. Your code stays the
				same: your backend{" "}
				<a href="/docs/cloud/authentication">signs tokens and manages grants</a>{" "}
				exactly as with your project.
			</p>
			<CodeBlock title=".env.development" code={localEnvironment} />
			<p>
				These development secrets are the same for everyone and never change, so
				you can commit them in an environment file for your team. They protect
				nothing, which is fine: the server only listens on your machine. To use
				your own, of at least 32 characters each, set them when you start it:
			</p>
			<CodeBlock title="terminal" code={localSecrets} />

			<h2>Storage and options</h2>
			<p>
				Each root is one SQLite file in <code>.pulsify/dev</code>, which you can
				copy, or delete to start again while the server is stopped. Add{" "}
				<code>.pulsify</code> to your <code>.gitignore</code>. Roots compact and
				expire as in the cloud; the limits of your plan are not enforced. Any
				other name than <code>dev</code> at the end of the URL is another
				project, with its own roots. <code>--port</code>, <code>--host</code>{" "}
				and <code>--dir</code> change where it listens and stores.
			</p>
		</>
	);
}
