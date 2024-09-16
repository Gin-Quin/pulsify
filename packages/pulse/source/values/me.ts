import { createRandomActorId } from "../functions/createRandomActorId"
import { type Actor } from "../types/Actor"

export const me: Actor = {
	id: createRandomActorId(),
	clock: 0n,
}
