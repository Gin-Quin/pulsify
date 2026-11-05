/** Compact deterministic mismatch detector, not an authentication primitive. */
export function fingerprintBytes(bytes: Uint8Array): string {
	let a = 0x811c9dc5,
		b = 0x9e3779b9,
		c = 0x85ebca6b,
		d = 0xc2b2ae35;
	for (const byte of bytes) {
		a = Math.imul(a ^ byte, 16777619);
		b = Math.imul(b ^ byte, 2246822519);
		c = Math.imul(c ^ byte, 3266489917);
		d = Math.imul(d ^ byte, 668265263);
	}
	return [a, b, c, d]
		.map((part) => (part >>> 0).toString(16).padStart(8, "0"))
		.join("");
}
