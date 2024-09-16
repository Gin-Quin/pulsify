import { type IncrementableUpdate } from "../types/Update"
import { BasePulse } from "./BasePulse"

export class PulseIncrementable extends BasePulse<number> {
	state = Array<IncrementableUpdate>
}
