/**
 * Create a new random actor ID.
 */
export function createRandomActorId(): bigint {
	const bigIntArray = new BigUint64Array(1)
	crypto.getRandomValues(bigIntArray)
	return bigIntArray[0]
}
