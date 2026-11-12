import { getCurrentWindow } from "@tauri-apps/api/window";

/** A user activity to drive, such as `userActivity` from `pulsify-cloud`. */
export type ActivityTarget = { set(present: boolean): void };
export type TauriActivityWindow = Pick<
	ReturnType<typeof getCurrentWindow>,
	"isMinimized" | "isVisible" | "onResized" | "onFocusChanged"
>;

/**
 * Report the native window state to a user activity: minimized or hidden
 * means away, shown or focused means back. Webviews do not always tell the
 * page: WebView2 (Windows) never reports a minimized window as hidden.
 * Resolves to a function that stops watching.
 */
export async function watchTauriActivity(
	targets: ActivityTarget | readonly ActivityTarget[],
	options: { window?: TauriActivityWindow } = {},
): Promise<() => void> {
	const appWindow = options.window ?? getCurrentWindow();
	const list = Array.isArray(targets) ? targets : [targets as ActivityTarget];
	let shown: boolean | undefined;
	const report = (present: boolean) => {
		shown = present;
		for (const target of list) target.set(present);
	};
	const update = async () => {
		const [minimized, visible] = await Promise.all([
			appWindow.isMinimized(),
			appWindow.isVisible(),
		]);
		const present = visible && !minimized;
		// Resizing fires continuously: report changes only.
		if (present !== shown) report(present);
	};
	const check = () => void update().catch(() => {});
	const stops = await Promise.all([
		appWindow.onResized(check),
		appWindow.onFocusChanged(({ payload: focused }) => {
			// Focus is user activity; losing it may mean minimized or hidden.
			if (focused) report(true);
			else check();
		}),
	]);
	await update().catch(() => {});
	return () => {
		for (const stop of stops) stop();
	};
}
