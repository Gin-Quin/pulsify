// Bundle an isolated copy with the sibling codec source; never mutate dependencies/lockfiles.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = new URL("../", import.meta.url).pathname;
const source = new URL("../../codec/source/index.ts", import.meta.url).pathname;
if (!(await Bun.file(source).exists()))
	throw new Error("Sibling ../codec is missing");
const directory = await mkdtemp(join(tmpdir(), "pulsify-codec-"));
try {
	const result = await Bun.build({
		entrypoints: [
			`${root}packages/pulse/source/index.ts`,
			`${root}packages/pulse/source/protocol.ts`,
			`${root}packages/pulse/source/connection/PulsePatch.ts`,
		],
		outdir: directory,
		target: "browser",
		format: "esm",
		plugins: [
			{
				name: "sibling-codec",
				setup(build) {
					build.onResolve({ filter: /^@gin-quin\/codec$/ }, () => ({
						path: source,
					}));
				},
			},
		],
	});
	if (!result.success)
		throw new AggregateError(result.logs, "Local codec build failed");
	const { encodeMessage, decodeMessage } = await import(
		`${directory}/protocol.js`
	);
	const fixtures = await Bun.file(`${root}fixtures/protocol.json`).json();
	const { encodeOperations, decodeOperations } = await import(
		`${directory}/connection/PulsePatch.js`
	);
	for (const fixture of fixtures.operations) {
		const bytes = new Uint8Array(fixture.bytes);
		if (
			Buffer.compare(
				Buffer.from(bytes),
				Buffer.from(encodeOperations(decodeOperations(bytes))),
			) !== 0
		)
			throw new Error(`Local codec breaks operation fixture: ${fixture.name}`);
	}
	for (const fixture of fixtures.messages) {
		const bytes = new Uint8Array(fixture.bytes);
		if (
			Buffer.compare(
				Buffer.from(bytes),
				Buffer.from(encodeMessage(decodeMessage(bytes))),
			) !== 0
		)
			throw new Error(`Local codec breaks fixture: ${fixture.name}`);
	}
	const api = await import(`${directory}/index.js`);
	const Doc = api.definePulse("LocalCodec").materialize();
	const connector = api.createMemoryConnector();
	const a = api.createPulse(
		Doc,
		{ id: "local-codec", value: 1 },
		{ scope: api.createPulseScope(), connectors: [connector] },
	);
	await api.connectPulse(a).synced;
	const b = await api.loadPulse(Doc, a.id, {
		scope: api.createPulseScope(),
		connectors: [connector],
		waitFor: "all",
	});
	a.value = 2;
	await api.getPulseMeta(a).connections[0].syncBack();
	if (b.value !== 2) throw new Error("Local codec synchronization failed");
	const Typed = api
		.definePulse("LocalCodecState", {
			_type: "object",
			fields: { value: "float64" },
		})
		.materialize();
	const x = api.createPulse(
		Typed,
		{ id: "local-codec-state", value: 0 },
		{ scope: api.createPulseScope(), connectors: [connector] },
	);
	await api.connectPulse(x).synced;
	const y = await api.loadPulse(Typed, x.id, {
		scope: api.createPulseScope(),
		connectors: [connector],
		waitFor: "all",
	});
	api.disconnectPulse(x);
	api.disconnectPulse(y);
	const base = api.getPulseVersions(y).state;
	for (let i = 1; i <= 100; i++) x.value = i;
	const frames = api.exportPulseUpdates(x, base, { peerVersion: 3 });
	api.applyPulseUpdates(y, frames);
	if (frames[0][0] !== 3 || y.value !== 100)
		throw new Error("Local codec state exchange failed");
	api.destroyPulse(x);
	api.destroyPulse(y);
	api.destroyPulse(a);
	api.destroyPulse(b);
	console.log(
		JSON.stringify({
			codec: source,
			fixtures: fixtures.messages.length,
			synchronization: "passed",
		}),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
