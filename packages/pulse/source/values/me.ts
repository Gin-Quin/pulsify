let myId = BigInt(Math.random() * 1000)

export const me = () => myId

export const setMe = (id: bigint) => {
	myId = id
}
