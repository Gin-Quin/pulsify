import type { Entry } from "pulse/types/Entry";
import { BasePulse } from "./BasePulse";
import type { Update } from "pulse/types/Update";
import { assimilateUpdate } from "pulse/types/State";

export class PulseObject<
	Properties extends Record<string, unknown>,
> extends BasePulse<Properties, Properties[keyof Properties]> {
	state: Partial<
		Record<keyof Properties, Array<Update<Properties[keyof Properties]>>>
	> = {};

	assimilateUpdate(update: Update<Properties[keyof Properties]>): boolean {
		const key = update.key as keyof Properties;

		if (!key) {
			throw new Error(`Key is missing`);
		}

		this.state[key] ??= [];
		return assimilateUpdate(this.state[key], update);
	}
}
