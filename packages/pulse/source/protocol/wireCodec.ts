import {
	createCodec,
	createDecoder,
	type InferType,
	type Schema,
} from "@gin-quin/codec";
import { PulseError } from "./errors.js";
import { MAX_FRAME_BYTES } from "./limits.js";

/** Codec owns the schema. Pulsify only bounds the frame and consumes it fully. */
export function wireCodec<S extends Schema>(schema: S) {
	const codec = createCodec(schema);
	return {
		encode(value: InferType<S>): Uint8Array<ArrayBuffer> {
			const bytes = codec.encode(value);
			if (bytes.length > MAX_FRAME_BYTES)
				throw new PulseError("LIMIT_EXCEEDED", "Message exceeds 8 MiB");
			return bytes;
		},
		decode(bytes: Uint8Array): InferType<S> {
			if (bytes.length > MAX_FRAME_BYTES)
				throw new PulseError("LIMIT_EXCEEDED", "Message exceeds 8 MiB");
			try {
				const decoder = createDecoder(bytes);
				const value = codec.decode(decoder);
				if (decoder.pos !== bytes.length)
					throw new PulseError("INVALID_MESSAGE", "Trailing bytes");
				return value;
			} catch (error) {
				if (error instanceof PulseError) throw error;
				throw new PulseError("INVALID_MESSAGE", "Cannot decode message", {
					cause: error,
				});
			}
		},
	};
}
