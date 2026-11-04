import {
	createPulse,
	createPulseScope,
	definePulse,
	type PulseProperties,
} from "../source/index";
import type { PulseMessage } from "../source/protocol";

type V1 = PulseProperties<"User"> & { name: string; email: string };
type V2 = PulseProperties<"User"> & { name: string; emailV2: string };
export function typeAssertions(): void {
	const User = definePulse<V1>("User")
		.migrate<V2>("v2", (before) => ({ emailV2: before.email }))
		.materialize<V1>(({ bind }) => ({ email: bind("emailV2") }));
	const user = createPulse(
		User,
		{ name: "Ada", emailV2: "ada@example.com" },
		{ scope: createPulseScope() },
	);
	user.email = "test@example.com";
	// @ts-expect-error Public model uses email, not the storage alias.
	user.emailV2 = "hidden";
	// @ts-expect-error Managed IDs are readonly.
	user.id = "other";
	// @ts-expect-error Managed versions are readonly.
	user.version = 3;
	// @ts-expect-error Creation requires the latest stored schema.
	createPulse(User, { name: "Ada", email: "old@example.com" });
	// @ts-expect-error Migration must supply the new field.
	definePulse<V1>("User").migrate<V2>("v2", () => ({}));
	definePulse<V1>("User").migrate<V2>("v2", () => ({
		emailV2: "x",
		// @ts-expect-error Migrations cannot change managed properties.
		version: 2,
	}));
	// @ts-expect-error Discriminated messages must include their payload.
	const invalid: PulseMessage = { kind: 2, docId: "x", requestId: 1 };
	void invalid;
}
