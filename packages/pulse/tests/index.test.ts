import { describe, it, expect } from "bun:test";
import { PulseArray } from "pulse/pulses/PulseArray";

describe("PulseArray", () => {
	describe("Insertions", () => {
		it("handles insert, unshift, and push operations correctly", () => {
			const list = new PulseArray<number>([5, 4]);
			expect(list.value).toEqual([5, 4]);

			list.insert(1, [15, 2, 51]);
			expect(list.value).toEqual([5, 15, 2, 51, 4]);

			list.unshift(1, 3, 2);
			expect(list.value).toEqual([1, 3, 2, 5, 15, 2, 51, 4]);

			list.insert(1, [8, 10]);
			expect(list.value).toEqual([1, 8, 10, 3, 2, 5, 15, 2, 51, 4]);

			list.push(1, 2, 3);
			expect(list.value).toEqual([1, 8, 10, 3, 2, 5, 15, 2, 51, 4, 1, 2, 3]);
		});

		it("handles random operations correctly", () => {
			const list = new PulseArray<number>([]);
			const expected: Array<number> = [];

			for (let i = 0; i < 100; i++) {
				const operation = getRandomOperation(expected);
				applyRandomOperation(list, operation);
				applyRandomOperation(expected, operation);
				expect(list.value).toEqual(expected);
			}
		});
	});
});

const randomOperationKinds = [
	"insert-one",
	"insert-many",
	"push-one",
	"push-many",
	"unshift-one",
	"unshift-many",
	// "splice-one",
	// "splice-many",
] as const;

type RandomOperationKind = RandomOperation["kind"];

type RandomOperation =
	| {
			kind: "insert-one";
			value: number;
			index: number;
	  }
	| {
			kind: "insert-many";
			values: Array<number>;
			index: number;
	  }
	| {
			kind: "push-one";
			value: number;
	  }
	| {
			kind: "push-many";
			values: Array<number>;
	  }
	| {
			kind: "unshift-one";
			value: number;
	  }
	| {
			kind: "unshift-many";
			values: Array<number>;
	  };

function getRandomOperation(array: Array<number>): RandomOperation {
	const kind = getRandomOperationKind();
	switch (kind) {
		case "insert-one": {
			return {
				kind,
				value: generateRandomNumber(),
				index: generateRandomIndex(array),
			};
		}
		case "insert-many": {
			return {
				kind,
				values: getRandomOperationValues(),
				index: generateRandomIndex(array),
			};
		}
		case "push-one": {
			return { kind, value: generateRandomNumber() };
		}
		case "push-many": {
			return { kind, values: getRandomOperationValues() };
		}
		case "unshift-one": {
			return { kind, value: generateRandomNumber() };
		}
		case "unshift-many": {
			return { kind, values: getRandomOperationValues() };
		}
	}
}

function getRandomOperationKind(): RandomOperationKind {
	return randomOperationKinds[
		Math.floor(Math.random() * randomOperationKinds.length)
	];
}

function generateRandomIndex(array: Array<number>): number {
	return Math.floor(Math.random() * (array.length + 1));
}

function getRandomOperationValues(
	count = generateRandomNumber(2, 20),
): Array<number> {
	return Array.from({ length: count }, generateRandomNumber);
}

function generateRandomNumber(min = 0, max = 100): number {
	return Math.floor(Math.random() * (max - min)) + min;
}

function applyRandomOperation(
	array: Array<number>,
	operation: RandomOperation,
): void {
	switch (operation.kind) {
		case "insert-one": {
			array.splice(operation.index, 0, operation.value);
			break;
		}
		case "insert-many": {
			array.splice(operation.index, 0, ...operation.values);
			break;
		}
		case "unshift-one": {
			array.unshift(operation.value);
			break;
		}
		case "unshift-many": {
			array.unshift(...operation.values);
			break;
		}
		case "push-one": {
			array.push(operation.value);
			break;
		}
		case "push-many": {
			array.push(...operation.values);
			break;
		}
	}
}
