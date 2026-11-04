import {
	createPulseScope,
	definePulse,
	type PulseProperties,
} from "../source/index";
export type Document = PulseProperties<"Document"> & {
	title: string;
	nested: { count: number };
	items: { value: number }[];
	optional?: string;
};
export const Document = definePulse<Document>("Document").materialize();
export const options = () => ({ scope: createPulseScope() });
export const data = (id: string = crypto.randomUUID()) => ({
	id,
	title: "Hello 🌍",
	nested: { count: 0 },
	items: [{ value: 1 }, { value: 2 }],
});
export async function eventually(
	assertion: () => void,
	timeout = 1000,
): Promise<void> {
	const end = performance.now() + timeout;
	while (true) {
		try {
			assertion();
			return;
		} catch (error) {
			if (performance.now() >= end) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
