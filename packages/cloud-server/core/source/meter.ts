/** What a host measures of one root. */
export type CloudRootSize = {
	/** The size of the root's database. */
	bytes: number;
	/** Its open sockets. */
	connections: number;
};

/**
 * Counts and limits what one root serves, such as the plans of a hosted
 * service. Every host calls it at the same four moments, so a meter knows
 * nothing of the host it runs on. A host without a meter serves everything.
 */
export type CloudMeter = {
	/** A socket asks to open, and `size` counts it. False refuses it with `LIMIT_EXCEEDED`. */
	connect(size: CloudRootSize): Promise<boolean>;
	/** A management request reached the root. */
	request(size: () => CloudRootSize): Promise<void>;
	/**
	 * A client sent a binary frame. Resolves to the frame to answer instead
	 * when it is refused: the root then never sees it.
	 */
	frame(
		data: Uint8Array,
		size: () => CloudRootSize,
	): Promise<Uint8Array | undefined>;
	/** A socket closed, or the root was deleted or erased: `size` is what is left. */
	settle(size: CloudRootSize): Promise<void>;
};
