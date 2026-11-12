import {
	createEmitter,
	type UserActivityEvents,
	type UserActivityReason,
	type UserActivityState,
} from "./events.js";

export type UserActivityOptions = {
	/** Present while the user interacted within this long. Default 5 min; `Infinity` for screens nobody touches. */
	activeMs?: number;
	/**
	 * The same while the window does not have focus. Every webview reports a
	 * lost focus, including a minimized window whose page still claims to be
	 * visible (WebView2). Default 30 s.
	 */
	unfocusedMs?: number;
};
/**
 * Whether someone may be looking at this app: the window, not any server.
 * Connectors stop background pings while nobody is, so servers can sleep.
 */
export type UserActivity = {
	readonly state: UserActivityState;
	/** `change` and `return` listeners. A `change` listener is called at once with the current state. */
	on<E extends keyof UserActivityEvents>(
		event: E,
		listener: (...args: UserActivityEvents[E]) => void,
	): () => void;
	/**
	 * Forward a native signal the webview may not report: `false` (window
	 * minimized or hidden, app in the background) means away until `true`
	 * (window shown or focused, app resumed), which counts as user activity.
	 */
	set(present: boolean): void;
	/** Remove the page listeners. */
	dispose(): void;
};

/**
 * Recent input and focus are what every webview reports; visibility only
 * narrows them, since some webviews never report a hidden page (WebView2 in
 * Tauri). Outside a page (no `document`), present unless set otherwise.
 */
export function createUserActivity(
	options: UserActivityOptions = {},
): UserActivity {
	const activeMs = options.activeMs ?? 5 * 60_000;
	const unfocusedMs = options.unfocusedMs ?? 30_000;
	const emitter = createEmitter<UserActivityEvents>();
	let lastActivity = Date.now();
	let away = false;
	let focused = true;
	let reason: UserActivityReason = "start";
	let last: UserActivityState | undefined;
	let idle: ReturnType<typeof setTimeout> | undefined;
	let stop: (() => void) | undefined;
	const page = () => typeof document !== "undefined";
	const visible = () => !page() || document.visibilityState !== "hidden";
	const span = () => (focused ? activeMs : unfocusedMs);
	const present = () =>
		!away && (!page() || (visible() && Date.now() - lastActivity < span()));
	const snapshot = (): UserActivityState => ({
		present: present(),
		reason,
		visible: visible(),
		focused,
		away,
		lastActivity,
	});
	const evaluate = (why: UserActivityReason) => {
		const next = { ...snapshot(), reason: why };
		clearTimeout(idle);
		// UserActivity also ends with time alone: wake up when it would.
		if (next.present && page() && Number.isFinite(span()))
			idle = setTimeout(
				() => evaluate("idle"),
				lastActivity + span() - Date.now() + 1,
			);
		if (
			last &&
			next.present === last.present &&
			next.visible === last.visible &&
			next.focused === last.focused &&
			next.away === last.away
		)
			return;
		reason = why;
		last = next;
		emitter.emit("change", next);
	};
	/** A sign of the user: count it as activity. */
	const back = (why: UserActivityReason) => {
		lastActivity = Date.now();
		evaluate(why);
		if (present()) emitter.emit("return");
	};
	const start = () => {
		if (stop) return;
		focused =
			!page() || typeof document.hasFocus !== "function" || document.hasFocus();
		const input = () => {
			const wasPresent = present();
			lastActivity = Date.now();
			evaluate("input");
			if (!wasPresent && present()) emitter.emit("return");
		};
		const focus = () => {
			focused = true;
			back("focus");
		};
		const blur = () => {
			focused = false;
			evaluate("blur");
		};
		const visibility = () => (visible() ? back("visible") : evaluate("hidden"));
		const pageshow = () => back("pageshow");
		const resume = () => back("resume");
		const inputs = ["pointerdown", "keydown", "wheel", "touchstart"];
		const target = page() ? document : undefined;
		// Page lifecycle signals, when the webview reports them.
		target?.addEventListener("visibilitychange", visibility);
		target?.addEventListener("resume", resume);
		globalThis.addEventListener?.("focus", focus);
		globalThis.addEventListener?.("blur", blur);
		globalThis.addEventListener?.("pageshow", pageshow);
		for (const type of inputs)
			globalThis.addEventListener?.(type, input, {
				passive: true,
				capture: true,
			});
		stop = () => {
			clearTimeout(idle);
			target?.removeEventListener("visibilitychange", visibility);
			target?.removeEventListener("resume", resume);
			globalThis.removeEventListener?.("focus", focus);
			globalThis.removeEventListener?.("blur", blur);
			globalThis.removeEventListener?.("pageshow", pageshow);
			for (const type of inputs)
				globalThis.removeEventListener?.(type, input, { capture: true });
		};
		evaluate("start");
	};
	return {
		get state() {
			start();
			return snapshot();
		},
		on(event, listener) {
			const off = emitter.on(event, listener);
			const fresh = !stop;
			start();
			// A new listener sees the current state; a fresh start already sent it.
			if (event === "change" && !fresh)
				(listener as (state: UserActivityState) => void)(snapshot());
			return off;
		},
		set(value) {
			start();
			away = !value;
			if (value) back("native");
			else evaluate("native");
		},
		dispose() {
			stop?.();
			stop = undefined;
			last = undefined;
		},
	};
}

/** The user activity of this page, shared by every connector that is not given its own. */
export const userActivity: UserActivity = createUserActivity();
