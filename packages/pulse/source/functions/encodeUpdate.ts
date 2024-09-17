import { bunker } from "@digitak/bunker"
import type { Update } from "../types/Update"

export function encodeUpdate(update: Update): Uint8Array {
	return bunker(update)
}
