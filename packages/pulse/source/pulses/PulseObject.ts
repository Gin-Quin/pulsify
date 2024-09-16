import type { ObjectUpdate } from "../types/Update"
import { BasePulse } from "./BasePulse"

export class PulseObject<
	Properties extends Record<string, any>
> extends BasePulse<Properties> {
	state: Record<keyof Properties, Array<ObjectUpdate<Properties, keyof Properties>>>
}
