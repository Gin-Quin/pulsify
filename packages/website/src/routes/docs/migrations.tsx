import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";

const chain = `import { definePulse, object, optional } from "pulsify-core";

const userV1 = object({ name: "string", email: "string" });
const userV2 = object({ name: "string", email: "string", displayName: "string" });
const userV3 = object({
  name: "string", email: "string", displayName: "string", avatar: optional("string"),
});

export const User = definePulse("User", userV1)
  // V1 → V2: derive the new required field.
  .migrateTo(userV2, (before) => ({ displayName: before.name }))
  // V2 → V3: optional fields need no value, but the step records the version.
  .migrateTo(userV3, () => ({}))
  .materialize();

// Creation always takes the latest shape.
const user = createPulse(User, { name: "Ada", email: "ada@x.io", displayName: "Ada" });`;

const fix = `export const Person = definePulse("Person", personV1)
  // Published. Never edit this step again.
  .migrateTo(personV2, (before) => ({ displayName: before.name }))
  // Wrong casing shipped? Append a correction with the same schema.
  .migrateTo(personV2, (before) => ({ displayName: before.displayName.trim() }))
  .materialize();`;

const drift = `import { MigrationDriftError } from "pulsify-core";

try {
  await loadPulse(User, id, { connectors: [remote] });
} catch (error) {
  if (error instanceof MigrationDriftError) {
    // Another client is running a different V1→V2 chain. Nothing was written.
    console.error(error.details);
  }
}`;

export default function Migrations() {
	return (
		<>
			<Title>Migrations · Docs</Title>
			<h1>Migrations</h1>
			<p>
				Schemas change. Documents already exist on thousands of devices, some of
				them offline. Pulsify is the only CRDT framework that handles this for
				you.
			</p>

			<h2>Why migrations matter</h2>
			<p>
				With a central database you run one migration script and every row
				changes at once. A CRDT document has no single place to run it: copies
				live in browsers, in local stores and in the server log, and they must
				all converge. Rewriting history is not an option, since history is what
				makes merging work.
			</p>

			<h2>Lazy migration</h2>
			<p>
				Pulsify migrates <strong>pulse by pulse, when a pulse is loaded</strong>
				. A document records its version. When newer code opens it, the missing
				steps run in order, each producing an ordinary patch that synchronizes
				like any other edit. Peers already on the new version simply apply it.
				Documents that are never opened are never touched.
			</p>
			<CodeBlock title="user.ts" code={chain} />
			<ul>
				<li>
					<code>migrateTo(schema, fn)</code> appends a version. The callback
					receives a detached copy of the previous version and returns only the
					fields that are new or whose type changed.
				</li>
				<li>Migration callbacks must be deterministic and side-effect free.</li>
				<li>
					Rich text arrives as a plain string in <code>before</code>; the target
					schema restores collaborative semantics.
				</li>
				<li>A document already at the latest version does no extra work.</li>
			</ul>

			<h2>Never edit a step</h2>
			<p>
				A document that already reached V2 will not rerun the V1 → V2 callback.
				Changing that callback gives two documents of the same version different
				data. Append a new step instead, even when the schema stays the same.
			</p>
			<CodeBlock title="person.ts" code={fix} />

			<h2>Drift detection</h2>
			<p>
				Each version has a fingerprint chained from the previous one:{" "}
				<code>Fn = H(Fn-1, n, schemaHash)</code>. When a peer's chain disagrees,
				the incoming update is rejected with <code>MigrationDriftError</code>{" "}
				<strong>before</strong> it touches the document, and a loud warning
				describes both chains. A peer that merely lacks newer versions is
				reported as outdated, not as drift.
			</p>
			<CodeBlock title="load.ts" code={drift} />

			<Note kind="warn">
				Fingerprints cover schemas, not callback code. Changing only the body of
				a migration cannot be detected. Treat published steps as immutable and
				fix forward.
			</Note>

			<h2>Removing fields</h2>
			<p>
				You can drop a field from the schema, but its history stays in every
				replica and old clients may still write it. The clean way to retire a
				field is to keep it stored and hide it from the public type. That is{" "}
				<a href="/docs/materialization">materialization</a>.
			</p>
		</>
	);
}
