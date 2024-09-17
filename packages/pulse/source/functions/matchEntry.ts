import type { Entry } from "../types/Entry"
import type { Update } from "../types/Update"

export const matchEntry = (entry: Entry) => (update: Update) =>
	update.actor === entry.actor &&
	entry.clock >= update.clock &&
	entry.clock <= update.clock + BigInt(update.content.length)
