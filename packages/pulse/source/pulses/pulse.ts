export function pulse<T>(value: T): Pulse<T> {
	return new Pulse(value)
}
