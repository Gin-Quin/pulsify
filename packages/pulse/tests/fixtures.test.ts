import { expect, test } from "bun:test";
import fixtures from "../../../fixtures/protocol.json";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage";
import {
	decodeOperations,
	encodeOperations,
} from "../source/connection/PulsePatch";
import {
	decodePresenceFrame,
	encodePresenceFrame,
	isPresenceFrame,
} from "../source/protocol/presenceFrames";

for (const fixture of fixtures.messages)
	test(`stable wire bytes: ${fixture.name}`, () => {
		const bytes = new Uint8Array(fixture.bytes);
		expect(encodeMessage(decodeMessage(bytes))).toEqual(bytes);
	});
for (const fixture of fixtures.operations)
	test(`stable operation bytes: ${fixture.name}`, () => {
		const bytes = new Uint8Array(fixture.bytes);
		expect(encodeOperations(decodeOperations(bytes))).toEqual(bytes);
	});
for (const fixture of fixtures.presence)
	test(`stable presence bytes: ${fixture.name}`, () => {
		const bytes = new Uint8Array(fixture.bytes);
		expect(isPresenceFrame(bytes)).toBe(true);
		expect(encodePresenceFrame(decodePresenceFrame(bytes))).toEqual(bytes);
		// Not a document message: stores and older peers reject it.
		expect(() => decodeMessage(bytes)).toThrow();
	});
