import { object } from "@gin-quin/codec";
import { PulseError } from "./errors.js";
import { validateDocId } from "./validateDocId.js";
import { OPERATIONS_VERSION } from "./versions.js";
import { wireCodec } from "./wireCodec.js";

/** Frame kind 7 of envelope 1: live state that relays forward and never store. */
export const PRESENCE_KIND = 7;
/** One encoded presence state. */
export const MAX_PRESENCE_BYTES = 16 * 1024;
/** UTF-16 units of a channel key or a subject. */
export const MAX_PRESENCE_NAME = 256;

export const PresenceEvent = {
	/** A session asks the others for their state in a channel. */
	join: 0,
	/** The state of a peer in a channel. */
	state: 1,
	/** A peer has no state in a channel any more. */
	clear: 2,
	/** Relay only: a session ended, in every channel. */
	leave: 3,
} as const;
export type PresenceEvent = (typeof PresenceEvent)[keyof typeof PresenceEvent];

export type PresenceFrame = {
	docId: string;
	/** The session that sent the frame. Relays set it; clients send 0. */
	peer: number;
	/** The only peer to deliver the frame to, or 0 for every other peer. */
	to: number;
	event: PresenceEvent;
	/** Who the relay authenticated, or empty. Relays set it; clients send it empty. */
	subject: string;
	/** Channel name and schema fingerprint; empty in a leave. */
	channel: string;
	/** The encoded state; empty unless the event is a state. */
	state: Uint8Array;
};

const codec = wireCodec(
	object({
		protocolVersion: "uint",
		operationsVersion: "uint",
		kind: "uint",
		docId: "string",
		requestId: "uint",
		peer: "uint",
		to: "uint",
		event: "uint",
		subject: "string",
		channel: "string",
		state: "uint8Array",
	}),
);

/** Whether a frame is a presence frame, from its three header bytes. */
export function isPresenceFrame(bytes: Uint8Array): boolean {
	return (
		bytes[0] === 1 &&
		bytes[1] === OPERATIONS_VERSION &&
		bytes[2] === PRESENCE_KIND
	);
}

function validate(frame: PresenceFrame): void {
	validateDocId(frame.docId);
	if (
		!Number.isSafeInteger(frame.peer) ||
		frame.peer < 0 ||
		!Number.isSafeInteger(frame.to) ||
		frame.to < 0 ||
		!(frame.event >= 0 && frame.event <= 3) ||
		frame.subject.length > MAX_PRESENCE_NAME ||
		frame.channel.length > MAX_PRESENCE_NAME ||
		!frame.subject.isWellFormed() ||
		!frame.channel.isWellFormed() ||
		(frame.event === PresenceEvent.leave) !== !frame.channel ||
		(frame.event !== PresenceEvent.state && frame.state.length > 0)
	)
		throw new PulseError("INVALID_MESSAGE", "Invalid presence frame");
	if (frame.state.length > MAX_PRESENCE_BYTES)
		throw new PulseError("LIMIT_EXCEEDED", "Presence state exceeds 16 KiB");
}

export function encodePresenceFrame(
	frame: PresenceFrame,
): Uint8Array<ArrayBuffer> {
	validate(frame);
	return codec.encode({
		protocolVersion: 1,
		operationsVersion: OPERATIONS_VERSION,
		kind: PRESENCE_KIND,
		requestId: 0,
		...frame,
	});
}

export function decodePresenceFrame(bytes: Uint8Array): PresenceFrame {
	if (!isPresenceFrame(bytes))
		throw new PulseError("INVALID_MESSAGE", "Not a presence frame");
	const { docId, requestId, peer, to, event, subject, channel, state } =
		codec.decode(bytes);
	if (requestId !== 0)
		throw new PulseError("INVALID_MESSAGE", "Invalid presence frame");
	const frame = { docId, peer, to, event, subject, channel, state };
	validate(frame as PresenceFrame);
	return frame as PresenceFrame;
}

/** Presence frames a relay forwards for one session per second; the rest is dropped. */
export const MAX_PRESENCE_RATE = 200;

/**
 * A relay's budget for one session: clients throttle themselves, a relay
 * cannot trust them to. Returns whether one more frame may be forwarded now.
 */
export function createPresenceBudget(limit = MAX_PRESENCE_RATE): () => boolean {
	let second = 0;
	let count = 0;
	return () => {
		const now = Math.floor(Date.now() / 1000);
		if (now !== second) {
			second = now;
			count = 0;
		}
		return ++count <= limit;
	};
}

/** The session a relay received a presence frame from. */
export type PresenceSender = {
	/** Unique among the open sessions of the document; positive. */
	peer: number;
	/** The user the relay authenticated, shown to the other peers. */
	subject?: string;
};
/** What a relay does with a presence frame: forward `frame`, never store it. */
export type PresenceRelay = {
	docId: string;
	/** The frame as the other peers receive it, naming its sender. */
	frame: Uint8Array<ArrayBuffer>;
	/** The only peer to send it to; every other peer of the document when absent. */
	to?: number;
};

/**
 * Check a presence frame received from a client and name its sender in it.
 * The relay keeps nothing: it forwards the result to the document's other
 * sessions that use presence, or to the one peer the frame answers.
 */
export function relayPresenceFrame(
	bytes: Uint8Array,
	sender: PresenceSender,
): PresenceRelay {
	const frame = decodePresenceFrame(bytes);
	if (!Number.isSafeInteger(sender.peer) || sender.peer < 1)
		throw new PulseError(
			"INVALID_MESSAGE",
			"This session has no presence peer number",
		);
	// Only a relay knows that a session ended.
	if (frame.event === PresenceEvent.leave)
		throw new PulseError("INVALID_MESSAGE", "Invalid presence frame");
	return {
		docId: frame.docId,
		frame: encodePresenceFrame({
			...frame,
			peer: sender.peer,
			subject: sender.subject ?? "",
		}),
		...(frame.to ? { to: frame.to } : {}),
	};
}

/** The frame a relay sends the other sessions of a document when one ends. */
export function encodePresenceLeave(
	docId: string,
	peer: number,
): Uint8Array<ArrayBuffer> {
	return encodePresenceFrame({
		docId,
		peer,
		to: 0,
		event: PresenceEvent.leave,
		subject: "",
		channel: "",
		state: new Uint8Array(),
	});
}
