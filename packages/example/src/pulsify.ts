import {
	array,
	constant,
	createPulse,
	definePresence,
	definePulse,
	frozen,
	isOnline,
	loadPulse,
	map,
	object,
	optional,
	plainText,
	PulseError,
	richText,
	setDefaultPulseOptions,
	setOnlineMode,
	sub,
	tree,
	tuple,
	union,
	type ModelFromDefinition,
	type Pulse,
} from "pulsify-core";
import { createCloudConnector } from "pulsify-cloud";

export const RichDoc = definePulse(
	"RichDoc",
	object({ body: richText() }),
).materialize();
export const PlainDoc = definePulse(
	"PlainDoc",
	object({ body: plainText() }),
).materialize();
// ponytail: sub() compiles its definition at once, so a character cannot link other characters.
const noteRef = union("string", {
	rich: { ref: sub(RichDoc) },
	plain: { ref: sub(PlainDoc) },
});
export const Character = definePulse(
	"Character",
	object({
		name: "string", // replaced as a whole: the last writer wins
		nickname: optional("string"),
		age: "uint",
		height: "float64",
		alive: "boolean",
		role: "string",
		position: frozen(tuple("int", "int")), // only replaced as a whole
		createdAt: constant("float64"), // fixed at creation
		bio: plainText(), // concurrent edits merge
		tags: array("string"),
		stats: map("int"),
		inventory: array(object({ item: "string", quantity: "uint" })),
		links: array(noteRef), // sub-pulse references to other files
	}),
).materialize();
export const Workspace = definePulse(
	"Workspace",
	object({
		files: tree(
			object({
				name: "string",
				// A folder has no file.
				file: optional(
					union("string", {
						rich: { ref: sub(RichDoc) },
						plain: { ref: sub(PlainDoc) },
						character: { ref: sub(Character) },
					}),
				),
			}),
		),
	}),
).materialize();
export type Workspace = Pulse<ModelFromDefinition<typeof Workspace>>;
export type Character = Pulse<ModelFromDefinition<typeof Character>>;

/** Who has the workspace open, and which file. */
export const Viewer = definePresence(
	"viewer",
	object({ name: "string", file: "string" }),
);
/** This tab's name, kept across reloads of the tab. */
export const me = (sessionStorage["name"] ??= `Visiteur ${Math.floor(
	Math.random() * 1000,
)}`) as string;

const url = import.meta.env.VITE_PULSIFY_URL as string | undefined;
const token = import.meta.env.VITE_PULSIFY_TOKEN as string | undefined;
if (!url || !token)
	throw new Error("Lancez `bun run setup` dans packages/example.");

const sockets = new Set<WebSocket>();
export const cloud = createCloudConnector({
	url,
	token,
	createSocket(url, protocols) {
		const socket = new WebSocket(url, protocols);
		sockets.add(socket);
		socket.addEventListener("close", () => sockets.delete(socket));
		return socket;
	},
});
setDefaultPulseOptions({ connectors: [cloud] });

/**
 * Simulate the network: offline closes every socket as a lost connection
 * would, and pauses reconnection until online again.
 */
export function setOnline(online: boolean) {
	setOnlineMode(online);
	if (!online) for (const socket of sockets) socket.close();
}
export { isOnline };

export const ROOT = "example";
/** The workspace document, created by its first visitor. Files load when opened. */
export async function openWorkspace(): Promise<Workspace> {
	try {
		return await loadPulse(Workspace, ROOT, { subPulses: false });
	} catch (error) {
		if (!(error instanceof PulseError && error.code === "NOT_FOUND"))
			throw error;
		// ponytail: two first visitors at the same instant both create it and one tree wins; create it in setup.ts if that matters.
		return createPulse(Workspace, { id: ROOT, files: {} }, { connect: true });
	}
}
