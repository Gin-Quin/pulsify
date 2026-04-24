import { type IncrementableUpdate } from "../types/Update";
import { PulseState } from "./PulseState";

export class PulseIncrementable extends PulseState<number> {
	state = Array<IncrementableUpdate>;
}
