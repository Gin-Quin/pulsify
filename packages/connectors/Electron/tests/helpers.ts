import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { array, object } from "@gin-quin/codec";
import {
	definePulse,
	getPulseMeta,
	richText,
	sub,
	type Pulse,
} from "@pulsify/core";
import { vectorCovers } from "@pulsify/core/protocol";
import {
	createElectronConnector,
	exposePulsifyBridge,
} from "../source/index";
import {
	servePulsifyStore,
	type BetterSqliteDatabase,
	type PulsifyStoreServer,
} from "../source/main";
import { FakeIpcMain, FakeWindow } from "./fakeElectron";

export const Note = definePulse(
	"Note",
	object({
		title: "string",
		body: richText(),
		tags: array("string"),
		meta: object({ count: "uint" }),
	}),
).materialize();
export const Notebook = definePulse(
	"Notebook",
	object({ name: "string", notes: array(sub(Note)) }),
).materialize();

const directories: string[] = [];
afterAll(() => {
	for (const directory of directories)
		rmSync(directory, { recursive: true, force: true });
});
export function temporaryFile(name = "pulsify.sqlite"): string {
	const directory = mkdtempSync(join(tmpdir(), "pulsify-electron-"));
	directories.push(directory);
	return join(directory, name);
}

/** One Electron app: a main process serving the store and its windows. */
export function createApp(database: BetterSqliteDatabase | string) {
	const ipcMain = new FakeIpcMain();
	const server: PulsifyStoreServer = servePulsifyStore({ ipcMain, database });
	const windows: FakeWindow[] = [];
	return {
		ipcMain,
		server,
		windows,
		openWindow() {
			const window = new FakeWindow(ipcMain);
			exposePulsifyBridge({
				contextBridge: window.contextBridge(),
				ipcRenderer: window.ipcRenderer,
			});
			windows.push(window);
			return { window, connector: createElectronConnector(window.bridge()) };
		},
	};
}

export async function eventually(
	assertion: () => void,
	timeout = 2000,
): Promise<void> {
	const end = performance.now() + timeout;
	while (true) {
		try {
			assertion();
			return;
		} catch (error) {
			if (performance.now() >= end) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

/** Resolves once every connection of the pulse acknowledged all local rows. */
export function persisted(pulse: Pulse<any>): Promise<void> {
	const meta = getPulseMeta(pulse);
	return eventually(() => {
		for (const connection of meta.connections)
			if (!vectorCovers(connection.clockVector, meta.log.vector))
				throw new Error(`${meta.id} is not persisted`);
	});
}
