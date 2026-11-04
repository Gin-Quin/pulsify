export function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	// Independent lifecycle promises may be observed later (e.g. ready before synced).
	void promise.catch(() => {});
	return { promise, resolve, reject };
}
