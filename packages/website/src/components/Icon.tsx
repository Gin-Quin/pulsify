import type { JSX } from "solid-js";

const paths = {
	github:
		"M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z",
	arrow: "M5 12h14m-6-6 6 6-6 6",
	layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
	bolt: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
	external: "M7 17 17 7M8 7h9v9",
	check: "m5 12 5 5L20 7",
	cross: "M6 6l12 12M18 6 6 18",
	shield: "M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3Z",
	branch:
		"M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0c0 4-4 5-8 6",
	database:
		"M12 3c-5 0-8 1.5-8 3v12c0 1.5 3 3 8 3s8-1.5 8-3V6c0-1.5-3-3-8-3Zm-8 3c0 1.5 3 3 8 3s8-1.5 8-3M4 12c0 1.5 3 3 8 3s8-1.5 8-3",
	cloud: "M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9.5a3.5 3.5 0 0 1-.5 7H7Z",
	cube: "m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 0v9m0 0 8-4.5M12 12l-8-4.5",
	eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
	sync: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8m0-5v5h-5m5 4a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16m5 0H3v5",
	window:
		"M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm-2 5h20M6 6.5h.01m2.99 0h.01",
	globe:
		"M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20",
	monitor:
		"M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm4 18h8m-4-4v4",
	phone:
		"M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm5 16h.01",
} as const;

export type IconName = keyof typeof paths;

export function Icon(props: {
	name: IconName;
	size?: string;
	class?: string;
}): JSX.Element {
	const filled = () => props.name === "github";
	return (
		<svg
			class={props.class}
			width={props.size ?? "1.25em"}
			height={props.size ?? "1.25em"}
			viewBox="0 0 24 24"
			fill={filled() ? "currentColor" : "none"}
			stroke={filled() ? "none" : "currentColor"}
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d={paths[props.name]} />
		</svg>
	);
}
