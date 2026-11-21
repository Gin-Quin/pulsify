import { describe, expect, test } from "bun:test";
import { array, object, optional } from "@gin-quin/codec";
import {
	connectPulse,
	createMemoryConnector,
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	loadPulse,
	PulseRelay,
	snapshotPulse,
	sub,
	subscribePulse,
	pulseRef,
	type PulseRef,
} from "../source/index";

const Document = definePulse(
	"Document",
	object({ title: "string" }),
).materialize();
const Project = definePulse(
	"Project",
	object({ name: "string", documents: array(sub(Document)) }),
).materialize();
const User = definePulse(
	"User",
	object({
		name: "string",
		projects: array(sub(Project)),
		favorite: optional(sub(Project)),
	}),
).materialize();

function tree(connectors = [createMemoryConnector()]) {
	const scope = createPulseScope();
	const user = createPulse(
		User,
		{ id: "1234", name: "Ada", projects: [] },
		{ scope, connectors },
	);
	const project = createPulse(
		Project,
		{ name: "Engine", documents: [] },
		{ parent: user },
	);
	const document = createPulse(
		Document,
		{ title: "Spec" },
		{ parent: project },
	);
	project.documents.push(pulseRef(document));
	user.projects.push(pulseRef(project));
	return { scope, user, project, document };
}

describe("sub-pulses", () => {
	test("IDs are prefixed and handles resolve through the scope", () => {
		const { scope, user, project, document } = tree();
		expect(project.id.startsWith("1234/")).toBe(true);
		expect(document.id.startsWith(`${project.id}/`)).toBe(true);
		const handle: PulseRef<typeof Project> = user.projects[0]!;
		expect(handle.id).toBe(project.id);
		expect(handle.pulse).toBe(project);
		expect(handle.pulse?.documents[0]?.pulse?.title).toBe("Spec");
		expect(snapshotPulse(user).projects).toEqual([project.id]);
		expect(user.favorite).toBeUndefined();
		user.favorite = pulseRef(project);
		expect(user.favorite?.pulse).toBe(project);
		const other = createPulse(
			Project,
			{ name: "Other", documents: [] },
			{
				parent: user,
			},
		);
		// Runtime writes also accept a pulse or a raw ID.
		(user as { favorite: unknown }).favorite = other;
		expect(user.favorite?.id).toBe(other.id);
		(user as { favorite: unknown }).favorite = "1234/missing";
		expect(user.favorite?.pulse).toBeUndefined();
		expect(snapshotPulse(user).favorite).toBe("1234/missing");
		expect(scope.pulses.size).toBe(4);
		expect(() =>
			createPulse(
				Project,
				{ id: "other", name: "x", documents: [] },
				{
					parent: user,
				},
			),
		).toThrow(/must start with 1234\//);
	});

	test("subPulses loads all sub-pulses by default or none; load() fetches one later", async () => {
		const relay = new PulseRelay();
		const connector = createMemoryConnector(relay);
		const { user, project, document } = tree([connector]);
		await Promise.all(
			[user, project, document].map((pulse) => connectPulse(pulse).synced),
		);

		const shallow = createPulseScope();
		const loaded = await loadPulse(User, "1234", {
			scope: shallow,
			connectors: [connector],
			waitFor: "all",
			subPulses: false,
		});
		expect(loaded.projects[0]!.pulse).toBeUndefined();
		const fetched = await loaded.projects[0]!.load({
			waitFor: "all",
			subPulses: false,
		});
		expect(fetched.name).toBe("Engine");
		expect(loaded.projects[0]!.pulse).toBe(fetched);
		expect(fetched.documents[0]!.pulse).toBeUndefined();

		const full = createPulseScope();
		const fullUser = await loadPulse(User, "1234", {
			scope: full,
			connectors: [connector],
			waitFor: "all",
		});
		expect(fullUser.projects[0]!.pulse?.documents[0]!.pulse?.title).toBe(
			"Spec",
		);
		expect(full.pulses.size).toBe(3);

		const child = await loadPulse(Document, document.id, {
			scope: createPulseScope(),
			connectors: [connector],
		});
		expect(child.title).toBe("Spec");
	});

	test("a dangling ID does not fail the load of its parent", async () => {
		const connector = createMemoryConnector(new PulseRelay());
		const { user, project, document } = tree([connector]);
		// Typed writes take a reference; the runtime also accepts the ID.
		user.projects.push("1234/missing" as never);
		await Promise.all(
			[user, project, document].map((pulse) => connectPulse(pulse).synced),
		);

		const scope = createPulseScope();
		const loaded = await loadPulse(User, "1234", {
			scope,
			connectors: [connector],
		});
		expect(loaded.projects[0]!.pulse?.documents[0]!.pulse?.title).toBe("Spec");
		expect(loaded.projects[1]!.id).toBe("1234/missing");
		expect(loaded.projects[1]!.pulse).toBeUndefined();
		expect(scope.pulses.size).toBe(3);
		await expect(loaded.projects[1]!.load()).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	test("a sub-pulse created live by another client loads automatically and notifies parent subscribers", async () => {
		const relay = new PulseRelay();
		const connector = createMemoryConnector(relay);
		const aScope = createPulseScope();
		const aUser = createPulse(
			User,
			{ id: "live", name: "Ada", projects: [] },
			{ scope: aScope, connectors: [connector] },
		);
		await connectPulse(aUser).synced;

		const bScope = createPulseScope();
		const bUser = await loadPulse(User, "live", {
			scope: bScope,
			connectors: [connector],
			waitFor: "all",
		});
		const observed: (string | undefined)[][] = [];
		const stop = subscribePulse(bUser, () => {
			observed.push(bUser.projects.map((ref) => ref.pulse?.name));
		});

		const project = createPulse(
			Project,
			{ name: "Engine", documents: [] },
			{ parent: aUser },
		);
		const doc = createPulse(Document, { title: "Spec" }, { parent: project });
		project.documents.push(pulseRef(doc));
		await Promise.all([connectPulse(doc).synced, connectPulse(project).synced]);
		aUser.projects.push(pulseRef(project));

		for (
			let i = 0;
			i < 50 && bUser.projects[0]?.pulse?.documents[0]?.pulse?.title !== "Spec";
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));

		expect(bUser.projects[0]!.pulse?.name).toBe("Engine");
		expect(bUser.projects[0]!.pulse?.documents[0]!.pulse?.title).toBe("Spec");
		expect(observed.at(-1)).toEqual(["Engine"]);

		// Subsequent edits on A sync to the live-loaded sub-pulse on B.
		project.name = "Engine v2";
		for (
			let i = 0;
			i < 50 && bUser.projects[0]?.pulse?.name !== "Engine v2";
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(bUser.projects[0]!.pulse?.name).toBe("Engine v2");

		// Destroying the child pulse notifies parent subscribers that ref.pulse became undefined.
		destroyPulse(bUser.projects[0]!.pulse!);
		expect(bUser.projects[0]!.pulse).toBeUndefined();
		expect(observed.at(-1)).toEqual([undefined]);
		stop();
	});

	test("lazy parents do not auto-load live sub-pulses, and manual ref.load() notifies parent subscribers", async () => {
		const relay = new PulseRelay();
		const connector = createMemoryConnector(relay);
		const aUser = createPulse(
			User,
			{ id: "lazy-live", name: "Ada", projects: [] },
			{ scope: createPulseScope(), connectors: [connector] },
		);
		await connectPulse(aUser).synced;

		const bScope = createPulseScope();
		const bUser = await loadPulse(User, "lazy-live", {
			scope: bScope,
			connectors: [connector],
			waitFor: "all",
			subPulses: false,
		});
		const seen: (string | undefined)[][] = [];
		const stop = subscribePulse(bUser, () => {
			seen.push(bUser.projects.map((ref) => ref.pulse?.name));
		});

		const project = createPulse(
			Project,
			{ name: "Lazy", documents: [] },
			{ parent: aUser },
		);
		await connectPulse(project).synced;
		aUser.projects.push(pulseRef(project));

		for (let i = 0; i < 50 && bUser.projects.length === 0; i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		await new Promise((resolve) => setTimeout(resolve, 25));

		expect(bUser.projects[0]!.id).toBe(project.id);
		expect(bUser.projects[0]!.pulse).toBeUndefined();
		expect(seen.at(-1)).toEqual([undefined]);

		await bUser.projects[0]!.load({ waitFor: "all" });
		expect(bUser.projects[0]!.pulse?.name).toBe("Lazy");
		expect(seen.at(-1)).toEqual(["Lazy"]);
		stop();
	});
});
