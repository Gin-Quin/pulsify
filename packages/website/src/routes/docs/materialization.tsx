import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";

const basic = `import { createPulse, definePulse, object, type PulseProperties } from "pulsify-core";

const userV1 = object({ name: "string", email: "string" });
const userV2 = object({ name: "string", emailV2: "string" });

// The type the rest of the codebase sees.
type User = PulseProperties<"User"> & { name: string; email: string };

export const User = definePulse("User", userV1)
  .migrateTo(userV2, (before) => ({ emailV2: before.email.toLowerCase() }))
  .materialize<User>(({ bind }) => ({
    email: bind("emailV2"), // two-way alias; emailV2 is hidden
  }));

const user = createPulse(User, { name: "Ada", emailV2: "ada@x.io" });
user.email = "grace@x.io";  // writes emailV2
"emailV2" in user;          // false`;

const derived = `type Invoice = PulseProperties<"Invoice"> & {
  lines: { label: string; cents: number }[];
  total: number;              // read-only, derived
  currency: string;           // stored as "cur"
};

export const Invoice = definePulse("Invoice", invoiceSchema)
  .materialize<Invoice>(({ bind }) => ({
    currency: bind("cur"),
    total: {
      get: (data) => data.lines.reduce((sum, line) => sum + line.cents, 0),
      set: () => { throw new Error("total is derived"); },
    },
  }));`;

const keepStored = `const taskV1 = object({ title: "string", done: "boolean" });
const taskV2 = object({ title: "string", done: "boolean", status: "string" });

type Task = PulseProperties<"Task"> & { title: string; status: string };

export const Task = definePulse("Task", taskV1)
  .migrateTo(taskV2, (before) => ({ status: before.done ? "done" : "todo" }))
  .materialize<Task>(() => ({
    status: {
      // A late write from a V1 client still counts.
      get: (data) => (data.done ? "done" : data.status === "done" ? "todo" : data.status),
      // Keep done in sync so V1 clients stay correct.
      set: (data, value) => {
        data.status = value;
        data.done = value === "done";
      },
    },
  }));`;

export default function Materialization() {
	return (
		<>
			<Title>Materialization · Docs</Title>
			<h1>Materialization</h1>
			<p>
				A materializer turns the latest stored schema into the public type of a
				pulse. It is where you rename, hide and derive, so the rest of the
				codebase never sees migration scars.
			</p>

			<h2>Why not delete fields?</h2>
			<p>
				In a CRDT, removing a field is bad practice. Its operations remain in
				every replica, an offline client may still write it, and a later
				migration may need to read it. Store what you must; expose what you
				want.
			</p>
			<p>
				Say V2 replaces a <code>done</code> checkbox with a <code>status</code>.
				A phone still on V1 is offline and ticks a task. Meanwhile a laptop
				upgrades, and the migration sets <code>status</code> to{" "}
				<code>"todo"</code>. When the phone reconnects, its{" "}
				<code>done = true</code> arrives after the migration has already run. If
				V2 dropped <code>done</code>, nothing reads that write: the laptop shows
				the task as todo, the phone shows it as done. Keep <code>done</code>{" "}
				stored and leave it out of the public type instead:
			</p>
			<CodeBlock title="task.ts" code={keepStored} />

			<h2>Aliases with bind</h2>
			<p>
				<code>bind("storedField")</code> creates a typed two-way alias. The
				stored field disappears from enumeration, snapshots and the public type.
				Reads and writes go straight to the CRDT register, so aliases cost
				nothing.
			</p>
			<CodeBlock title="user.ts" code={basic} />

			<h2>Custom bindings</h2>
			<p>
				A binding is any object with <code>get(data)</code> and{" "}
				<code>set(data, value)</code>. Derived values do not consume a stored
				field.
			</p>
			<CodeBlock title="invoice.ts" code={derived} />

			<h2>One shape everywhere</h2>
			<p>
				Every consumer, from UI components to server jobs, imports the same
				definition and gets the same end type. When you ship V7 of a schema,
				nothing outside the definition file changes. Snapshots taken with{" "}
				<code>snapshotPulse</code> contain materialized fields too, so API
				responses and tests stay consistent.
			</p>

			<Note>
				Materializers are local TypeScript. They are never sent to a relay, and
				two clients may materialize the same stored data differently.
			</Note>
		</>
	);
}
