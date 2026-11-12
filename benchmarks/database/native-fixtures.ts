import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fixture, receiver, applyRows, type Profile } from "./fixtures.js";
import { createRuntime } from "../../packages/pulse/source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../../packages/pulse/source/pulses/PulseOptions.js";
import {
	createPulseScope,
	destroyPulse,
	exportPulseUpdates,
	getPulseMeta,
	getPulseVersions,
	snapshotPulse,
	applyPulseUpdates,
} from "../../packages/pulse/source/index.js";
import {
	encodeMessage,
	decodeMessage,
} from "../../packages/pulse/source/protocol.js";

const [command, path, profile = "medium", workers = "128", requests = "400"] =
	process.argv.slice(2);
if (command === "generate") {
	const f = fixture(profile as Profile, "native-database-fixture");
	const all = [...f.initial, ...f.patches.flat()];
	// A message carries a bounded number of rows; a long history is several frames.
	const chunks = Array.from({ length: Math.ceil(all.length / 1024) }, (_, i) =>
		all.slice(i * 1024, (i + 1) * 1024),
	);
	const frame = (rows: typeof all) =>
		Buffer.from(
			encodeMessage({ kind: 4, docId: f.docId, requestId: 0, vv: [], rows }),
		).toString("base64");
	const streams: string[][] = [];
	for (let worker = 0; worker < Number(workers); worker++) {
		const temporary = receiver(f.docId);
		const meta = getPulseMeta(temporary);
		// Use the same compiled definition as the public benchmark fixture.
		const peer = createRuntime(meta.definition, f.docId, {
			...defaultPulseOptions,
			sessionId: 80000 + worker,
			scope: createPulseScope(),
		});
		destroyPulse(temporary);
		try {
			for (const chunk of chunks) applyRows(peer, chunk);
			const stream: string[] = [];
			for (let i = 0; i < Number(requests); i++) {
				const before = getPulseVersions(peer).history;
				(peer as unknown as { revision: number }).revision =
					worker * 1_000_000 + i + 1;
				const frames = exportPulseUpdates(peer, before, { mode: "history" });
				if (frames.length !== 1)
					throw new Error("Expected one exact scalar patch");
				stream.push(Buffer.from(frames[0]!).toString("base64"));
			}
			streams.push(stream);
		} finally {
			destroyPulse(peer);
		}
	}
	await mkdir(dirname(path!), { recursive: true });
	await Bun.write(
		path!,
		JSON.stringify({
			profile,
			seed: chunks.map(frame),
			initial: frame(f.initial),
			remote: f.remote,
			streams,
		}),
	);
	console.log(
		`Generated ${profile}: ${workers} real actor streams × ${requests} patches`,
	);
} else if (command === "verify") {
	const report = await Bun.file(path!).json();
	let replays = 0;
	for (const cell of report.cells)
		for (const verification of cell.verification) {
			if (!verification.frames.length) continue;
			const a = receiver("native-database-fixture"),
				b = receiver("native-database-fixture");
			try {
				const frames = verification.frames.map(
					(s: string) => new Uint8Array(Buffer.from(s, "base64")),
				);
				applyPulseUpdates(a, frames);
				const rows = frames
					.flatMap((frame: Uint8Array) => {
						const message = decodeMessage(frame);
						if (!("rows" in message)) throw new Error("Expected history");
						return message.rows;
					})
					.toReversed();
				for (let i = 0; i < rows.length; i += 1024)
					applyRows(b, rows.slice(i, i + 1024));
				if (
					JSON.stringify(snapshotPulse(a)) !== JSON.stringify(snapshotPulse(b))
				)
					throw new Error("Materialization did not converge");
				if (
					JSON.stringify(getPulseVersions(a)) !==
					JSON.stringify(getPulseVersions(b))
				)
					throw new Error("Version mismatch");
				verification.materialized = true;
				verification.snapshotSha256 = new Bun.CryptoHasher("sha256")
					.update(JSON.stringify(snapshotPulse(a)))
					.digest("hex");
				verification.frames = [];
				replays++;
			} finally {
				destroyPulse(a);
				destroyPulse(b);
			}
		}
	report.materializationChecks = report.cells.reduce(
		(
			total: number,
			cell: { verification: Array<{ materialized?: boolean }> },
		) => total + cell.verification.filter((v) => v.materialized).length,
		0,
	);
	await Bun.write(path!, JSON.stringify(report));
	console.log(
		`Verified ${replays} new representative histories; ${report.materializationChecks} retained materialization proofs`,
	);
} else
	throw new Error(
		"Usage: native-fixtures.ts generate OUTPUT [PROFILE WORKERS REQUESTS] | verify REPORT",
	);
