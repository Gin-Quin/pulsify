/** Dense, lexicographic base-65536 keys. A unique suffix avoids concurrent ties. */
export function isFractionalPosition(key: unknown): key is string {
	return (
		typeof key === "string" &&
		/^[0-9a-f]+$/.test(key) &&
		key.length % 4 === 0 &&
		!key.endsWith("0000")
	);
}

const STEP = 8;

export function positionBetween(
	left: string | undefined,
	right: string | undefined,
	unique: string,
): string {
	for (const key of [left, right])
		if (key !== undefined && !isFractionalPosition(key))
			throw new TypeError("Invalid fractional position");
	if (left !== undefined && right !== undefined && left >= right)
		throw new RangeError("Positions must be ordered");
	const appending = left !== undefined && right === undefined;
	const prepending = left === undefined && right !== undefined;
	let prefix = "";
	for (let offset = 0; ; offset += 4) {
		const low =
			left && offset < left.length
				? Number.parseInt(left.slice(offset, offset + 4), 16)
				: 0;
		const high =
			right && offset < right.length
				? Number.parseInt(right.slice(offset, offset + 4), 16)
				: 65536;
		if (high - low > 1) {
			let digit: number;
			if (left === undefined && right === undefined && offset === 0)
				digit = 0x8000;
			else {
				const step = Math.min(STEP, (high - low) >>> 1);
				const fromHigh =
					prepending || (!appending && ((offset >>> 2) & 1) === 1);
				digit = fromHigh ? high - step : low + step;
			}
			return prefix + digit.toString(16).padStart(4, "0") + unique + "0001";
		}
		prefix += low.toString(16).padStart(4, "0");
		if (low < high) right = undefined;
	}
}
