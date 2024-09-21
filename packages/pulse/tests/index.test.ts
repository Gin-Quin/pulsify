import start from "fartest";
import { PulseArray } from "pulse/pulses/PulseArray";

start("PulseArray", ({ stage, same }) => {
	stage("Insertions");
	{
		const list = new PulseArray<number>([5, 4]);
		same(list.value, [5, 4]);

		list.insert(1, [15, 2, 51]);
		same(list.value, [5, 15, 2, 51, 4]);

		list.unshift(1, 3, 2);
		same(list.value, [1, 3, 2, 5, 15, 2, 51, 4]);

		list.insert(1, [8, 10]);
		same(list.value, [1, 8, 10, 3, 2, 5, 15, 2, 51, 4]);

		list.push(1, 2, 3);
		same(list.value, [1, 8, 10, 3, 2, 5, 15, 2, 51, 4, 1, 2, 3]);
	}
});
