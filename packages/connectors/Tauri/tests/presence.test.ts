import { expect, test } from "bun:test";
import { watchTauriPresence, type TauriPresenceWindow } from "../source/index";

/** A native window whose state and events we drive. */
function nativeWindow() {
	const state = { minimized: false, visible: true };
	const handlers = {
		resized: new Set<() => void>(),
		focus: new Set<(e: { payload: boolean }) => void>(),
	};
	const window = {
		isMinimized: async () => state.minimized,
		isVisible: async () => state.visible,
		onResized: async (handler: () => void) => {
			handlers.resized.add(handler);
			return () => handlers.resized.delete(handler);
		},
		onFocusChanged: async (handler: (e: { payload: boolean }) => void) => {
			handlers.focus.add(handler);
			return () => handlers.focus.delete(handler);
		},
	} as unknown as TauriPresenceWindow;
	return {
		window,
		state,
		handlers,
		resize: () => handlers.resized.forEach((h) => h()),
		focus: (payload: boolean) => handlers.focus.forEach((h) => h({ payload })),
	};
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("minimizing, hiding, restoring and focusing the window drive presence", async () => {
	const native = nativeWindow();
	const reports: boolean[] = [];
	const stop = await watchTauriPresence(
		[{ set: (present) => reports.push(present) }],
		{ window: native.window },
	);
	expect(reports).toEqual([true]);

	// Minimizing resizes and blurs the window; the page still claims to be visible.
	native.state.minimized = true;
	native.resize();
	native.focus(false);
	native.resize();
	await settle();
	expect(reports).toEqual([true, false]);

	native.state.minimized = false;
	native.resize();
	await settle();
	expect(reports).toEqual([true, false, true]);

	// Continuous resizing of a shown window reports nothing new.
	for (let i = 0; i < 5; i++) native.resize();
	await settle();
	expect(reports).toEqual([true, false, true]);

	// A tray app hiding its window: only the focus changes.
	native.state.visible = false;
	native.focus(false);
	await settle();
	expect(reports.at(-1)).toBe(false);

	// Focus is user activity, reported every time.
	native.state.visible = true;
	native.focus(true);
	native.focus(true);
	expect(reports.slice(-2)).toEqual([true, true]);

	stop();
	expect(native.handlers.resized.size + native.handlers.focus.size).toBe(0);
});

test("a window that starts minimized starts away", async () => {
	const native = nativeWindow();
	native.state.minimized = true;
	const reports: boolean[] = [];
	await watchTauriPresence(
		{ set: (present) => reports.push(present) },
		{
			window: native.window,
		},
	);
	expect(reports).toEqual([false]);
});
