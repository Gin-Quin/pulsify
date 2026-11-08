/** Dense, lexicographic base-65536 keys. A unique suffix avoids concurrent ties. */
export function isFractionalPosition(key: unknown): key is string {
	return (
		typeof key === "string" &&
		/^[0-9a-f]+$/.test(key) &&
		key.length % 4 === 0 &&
		!key.endsWith("0000")
	);
}

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
			const middle = Math.floor((low + high) / 2)
				.toString(16)
				.padStart(4, "0");
			return prefix + middle + unique + "0001";
		}
		prefix += low.toString(16).padStart(4, "0");
		if (low < high) right = undefined;
	}
}
