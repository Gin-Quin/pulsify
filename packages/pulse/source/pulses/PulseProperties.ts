export type PulseProperties<Kind extends string> = {
	readonly id: string;
	readonly kind: Kind;

	/**
	 * Current migration level applied.
	 * Starts at version 1.
	 */
	readonly version: number;

	/**
	 * Starts at 0 and grows by one each time the document is restored
	 * (`restorePulse`): edits made to an earlier generation are discarded.
	 */
	readonly generation?: number;
};
