import type { PulseVersionVector } from "./PulseVersionVector.js";
import type { PulsePatchRow } from "./PulsePatch.js";
/** A transport carries complete binary frames and owns no CRDT classes. */
export type ConnectorSession = {
	/** Set only after the endpoint has explicitly advertised/negotiated support. */
	protocolVersion?: 1 | 2 | 3;
	/**
	 * The endpoint relays presence frames (kind 7). Set only for an endpoint
	 * known to understand them: an older relay rejects the frames.
	 */
	presence?: boolean;
	/**
	 * Called before rows are uploaded, with the actors among their writers
	 * that this client created itself: an endpoint that authenticates its
	 * sessions can then bind these actors to the session's account. Rows of
	 * other actors, which this client only relays, are never declared.
	 */
	declareActors?(actors: readonly number[]): void;
	/**
	 * For a transport that cannot see a peer vanish (a plain WebSocket behind
	 * a NAT or proxy that drops it silently): after this long without any
	 * received frame, the pulse sends a sync request (kind 1, as on `online`)
	 * and reconnects unless it is answered within `timeoutMs`. One at a time:
	 * the idle wait starts again once it is answered. Unset: never.
	 */
	heartbeatMs?: number | undefined;
	send(bytes: Uint8Array): Promise<void>;
	close(): void;
};
export type Connector = {
	kind: "remote" | "local";
	/** Local cache presence, used to preserve offline-first loading before a network prefetch. */
	cached?(docId: string): Promise<boolean>;
	/** Optional subtree prefetch; absent/unsupported endpoints use ordinary loads. */
	prefetch?(
		docId: string,
		options: {
			descendants: boolean;
			/** Inactivity timeout during a streamed fetch, not a cap on total transfer time. */
			timeoutMs?: number;
			vectors: [string, PulseVersionVector][];
			signal?: AbortSignal | undefined;
			/** As in `open`: the `identity` of the scope that asks. */
			identity?: string | undefined;
		},
	): Promise<
		{ documents: Map<string, PulsePatchRow[]>; complete: boolean } | undefined
	>;
	/** NOT_FOUND error frames from this connector mean permanent deletion. */
	authoritativeDeletions?: boolean;
	/** Persist a deletion marker while retaining the supplied data for recovery. */
	markDeleted?(
		docId: string,
		recovery: readonly PulsePatchRow[],
	): Promise<void>;
	/**
	 * Consume rows proactively pushed by this endpoint for a descendant
	 * (`parent/…`) that has not been opened yet.
	 */
	takePushed?(docId: string): PulsePatchRow[] | undefined;
	/**
	 * Notify when the endpoint pushes rows for a descendant with no open
	 * session yet (for example, when a child finishes uploading right after
	 * its parent linked its ID).
	 */
	onPushed?(listener: (docId: string) => void): () => void;
	/**
	 * Local connectors: a name for the store behind this connector. Pulses reuse
	 * actor IDs among the pages that share the store. A local connector without
	 * it gives its pulses a random actor.
	 */
	actorPool?: string;
	open(input: {
		docId: string;
		/**
		 * Subscribe to live broadcasts of newly created descendants (`docId/…`)
		 * while this session is open, so sub-pulses arrive with their initial data.
		 */
		watchDescendants?: boolean;
		/**
		 * The `identity` of the pulse's scope, when it has one. A connector that
		 * authenticates as an account refuses a session for another identity.
		 */
		identity?: string | undefined;
		signal: AbortSignal;
		/**
		 * The endpoint did not accept these declared actors as the session's:
		 * another account has them. The pulse stops writing under them.
		 */
		onActorsRefused?(actors: readonly number[]): void;
		onMessage(bytes: Uint8Array): void;
		onClose(error?: Error): void;
	}): Promise<ConnectorSession>;
};
export type ConnectorKind = Connector["kind"];
