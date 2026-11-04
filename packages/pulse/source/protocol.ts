export {
	encodeMessage,
	decodeMessage,
	PulseMessageSchema,
	PulseMessageKind,
	PulseVersionVectorSchema,
	PulsePatchRowSchema,
	PROTOCOL_VERSION,
	OPERATIONS_VERSION,
} from "./connection/PulseMessage.js";
export type {
	PulseMessage,
	PulseConnectMessage,
	PulseSyncMessage,
	PulseSyncBackMessage,
	PulseUpdateMessage,
} from "./connection/PulseMessage.js";
export type { PulsePatchRow } from "./connection/PulsePatch.js";
export {
	validateVector,
	vectorCovers,
	mergeVectors,
} from "./connection/PulseVersionVector.js";
export type { PulseVersionVector } from "./connection/PulseVersionVector.js";
export { PatchLog } from "./protocol/PatchLog.js";
export { PulseRelay } from "./protocol/PulseRelay.js";
export { PulseError } from "./protocol/errors.js";
export { MAX_FRAME_BYTES } from "./protocol/limits.js";

export {
	encodeHistoryRequest,
	historyRequestOf,
	isStateMessage,
} from "./protocol/stateDeltas.js";
