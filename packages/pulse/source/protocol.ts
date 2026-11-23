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
export { chunkRows } from "./protocol/chunkRows.js";
export { PulseRelay } from "./protocol/PulseRelay.js";
export {
	relayStoreMessage,
	streamStoreMessage,
	encodeBroadcast,
} from "./protocol/StoreRelay.js";
export type {
	StoreRelaySession,
	StoreRelayResult,
	StoreRelayStreamResult,
	StoreRelayBroadcast,
} from "./protocol/StoreRelay.js";
export {
	PRESENCE_KIND,
	MAX_PRESENCE_BYTES,
	MAX_PRESENCE_RATE,
	createPresenceBudget,
	PresenceEvent,
	isPresenceFrame,
	encodePresenceFrame,
	decodePresenceFrame,
	relayPresenceFrame,
	encodePresenceLeave,
} from "./protocol/presenceFrames.js";
export type {
	PresenceFrame,
	PresenceRelay,
	PresenceSender,
} from "./protocol/presenceFrames.js";
export { PulseError, isRetryable, remoteError } from "./protocol/errors.js";
export { MAX_FRAME_BYTES } from "./protocol/limits.js";

export {
	encodeHistoryRequest,
	historyRequestOf,
	isStateMessage,
} from "./protocol/stateDeltas.js";

export { encodeRecoveryFrames } from "./protocol/recovery.js";
