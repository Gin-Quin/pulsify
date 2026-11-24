import {
	array,
	createPulse,
	definePresence,
	definePulse,
	frozen,
	object,
	record,
	type ModelFromDefinition,
	type Pulse,
} from "pulsify-core";
import { createMutablePulse, createPulsePresence } from "pulsify-solid";
import {
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type JSX,
} from "solid-js";
import { Icon, type IconName } from "~/components/Icon";
import { me, openRoom } from "./room";
import { Room, Shell } from "./Shell";
import styles from "./Whiteboard.module.css";

const Shape = object({
	kind: "string",
	x: "float64",
	y: "float64",
	/** The size of a box, or the vector of an arrow. */
	w: "float64",
	h: "float64",
	/** A pen stroke, relative to x and y: x0, y0, x1, y1… Only replaced as a whole. */
	points: frozen(array("float64")),
	text: "string",
	color: "string",
	/** Drawing order: the time it was created. */
	z: "float64",
});
const Sketch = definePulse(
	"DemoWhiteboard",
	object({ shapes: record(Shape) }),
).materialize();
type Sketch = Pulse<ModelFromDefinition<typeof Sketch>>;
type Shape = {
	kind: string;
	x: number;
	y: number;
	w: number;
	h: number;
	points: number[];
	text: string;
	color: string;
	z: number;
};

/** Everyone's pointer on the board, and the shape they selected. */
const Pointer = definePresence(
	"whiteboard-pointer",
	object({
		name: "string",
		color: "string",
		x: "float64",
		y: "float64",
		visible: "boolean",
		selected: "string",
	}),
	{ throttleMs: 30 },
);

type Tool = "select" | "rect" | "ellipse" | "arrow" | "pen" | "text";
const TOOLS: [Tool, IconName, string, string][] = [
	["select", "pointer", "Select and move", "v"],
	["rect", "square", "Rectangle", "r"],
	["ellipse", "circle", "Ellipse", "o"],
	["arrow", "line", "Arrow", "a"],
	["pen", "pen", "Pen", "p"],
	["text", "text", "Text", "t"],
];
const INKS = [
	"#e8f6f8",
	"#3df5e0",
	"#4fd6ff",
	"#e879f9",
	"#7cf5a8",
	"#f5e27a",
	"#ff7a7a",
];
const FONT = "Inter, system-ui, sans-serif";
const FONT_SIZE = 24;

export default function WhiteboardDemo() {
	return (
		<Room
			open={(signal) =>
				openRoom(
					Sketch,
					(id, options) =>
						createPulse(
							Sketch,
							{ id, shapes: {} },
							{ ...options, connect: true },
						),
					signal,
				)
			}
		>
			{(pulse: Sketch) => <Board pulse={pulse} />}
		</Room>
	);
}

function Board(props: { pulse: Sketch }) {
	const sketch = createMutablePulse(props.pulse);
	const shapes = props.pulse.shapes as unknown as Record<string, Shape>;
	const pointers = createPulsePresence(props.pulse, Pointer);
	const [tool, setTool] = createSignal<Tool>("select");
	const [ink, setInk] = createSignal(INKS[0]!);
	const [selected, select] = createSignal("");
	const [camera, setCamera] = createSignal({ x: 0, y: 0, scale: 1 });
	const [draft, setDraft] = createSignal<Shape>();
	const [editing, setEditing] = createSignal<{
		id?: string;
		x: number;
		y: number;
		text: string;
	}>();
	let svg!: SVGSVGElement;
	let layer!: SVGGElement;
	let drag:
		| { kind: "pan"; x: number; y: number; camera: { x: number; y: number } }
		| {
				kind: "move";
				id: string;
				x: number;
				y: number;
				from: { x: number; y: number };
		  }
		| undefined;

	const ids = () =>
		Object.keys(sketch.shapes).sort(
			(a, b) => sketch.shapes[a]!.z - sketch.shapes[b]!.z,
		);
	let pointer = { x: 0, y: 0, visible: false };
	const share = () =>
		pointers.set({
			name: me.name,
			color: me.color,
			...pointer,
			selected: selected(),
		});
	share();
	const choose = (id: string) => {
		select(id);
		share();
	};

	/** A point of the board under the mouse. */
	function toBoard(event: { clientX: number; clientY: number }) {
		const box = svg.getBoundingClientRect();
		const { x, y, scale } = camera();
		return {
			x: (event.clientX - box.left - x) / scale,
			y: (event.clientY - box.top - y) / scale,
		};
	}
	/** Zoom by `factor`, keeping the board point under (sx, sy) in place. */
	function zoom(factor: number, sx?: number, sy?: number) {
		const box = svg.getBoundingClientRect();
		const { x, y, scale } = camera();
		const next = Math.min(8, Math.max(0.1, scale * factor));
		const px = sx ?? box.width / 2;
		const py = sy ?? box.height / 2;
		setCamera({
			x: px - ((px - x) / scale) * next,
			y: py - ((py - y) / scale) * next,
			scale: next,
		});
	}

	function down(event: PointerEvent) {
		if (editing()) return commitText();
		svg.setPointerCapture(event.pointerId);
		const point = toBoard(event);
		const hit = (event.target as Element).closest("[data-id]");
		const id = hit?.getAttribute("data-id");
		if (event.button === 1 || (tool() === "select" && !id)) {
			choose("");
			drag = {
				kind: "pan",
				x: event.clientX,
				y: event.clientY,
				camera: camera(),
			};
		} else if (tool() === "select" && id) {
			choose(id);
			drag = {
				kind: "move",
				id,
				...point,
				from: { x: shapes[id]!.x, y: shapes[id]!.y },
			};
		} else if (tool() === "text") {
			event.preventDefault();
			setEditing({ ...point, text: "" });
		} else
			setDraft({
				kind: tool(),
				...point,
				w: 0,
				h: 0,
				points: [0, 0],
				text: "",
				color: ink(),
				z: Date.now(),
			});
	}
	function move(event: PointerEvent) {
		const point = toBoard(event);
		pointer = { ...point, visible: true };
		share();
		if (drag?.kind === "pan")
			setCamera({
				...camera(),
				x: drag.camera.x + event.clientX - drag.x,
				y: drag.camera.y + event.clientY - drag.y,
			});
		else if (drag?.kind === "move") {
			const shape = shapes[drag.id];
			if (!shape) return;
			shape.x = drag.from.x + point.x - drag.x;
			shape.y = drag.from.y + point.y - drag.y;
		}
		const shape = draft();
		if (!shape) return;
		const w = point.x - shape.x;
		const h = point.y - shape.y;
		setDraft({
			...shape,
			w,
			h,
			points: shape.kind === "pen" ? [...shape.points, w, h] : shape.points,
		});
	}
	function up() {
		drag = undefined;
		const shape = draft();
		setDraft(undefined);
		if (!shape || Math.hypot(shape.w, shape.h) < 4) return;
		// Boxes are stored with a positive size, whichever way they were drawn.
		if (shape.kind === "rect" || shape.kind === "ellipse")
			Object.assign(shape, {
				x: Math.min(shape.x, shape.x + shape.w),
				y: Math.min(shape.y, shape.y + shape.h),
				w: Math.abs(shape.w),
				h: Math.abs(shape.h),
			});
		const id = crypto.randomUUID().slice(0, 8);
		shapes[id] = shape;
		choose(id);
	}
	function wheel(event: WheelEvent) {
		event.preventDefault();
		const box = svg.getBoundingClientRect();
		// A pinch arrives with ctrlKey; scrolling pans.
		if (event.ctrlKey || event.metaKey)
			zoom(
				Math.exp(-event.deltaY * 0.01),
				event.clientX - box.left,
				event.clientY - box.top,
			);
		else
			setCamera({
				...camera(),
				x: camera().x - event.deltaX,
				y: camera().y - event.deltaY,
			});
	}
	function editText(event: MouseEvent) {
		const id = (event.target as Element)
			.closest("[data-id]")
			?.getAttribute("data-id");
		const shape = id && shapes[id];
		if (shape && shape.kind === "text")
			setEditing({ id, x: shape.x, y: shape.y, text: shape.text });
	}
	function commitText() {
		const text = editing();
		setEditing(undefined);
		if (!text) return;
		const value = text.text.trim();
		const shape = text.id ? shapes[text.id] : undefined;
		if (shape) {
			if (value) shape.text = value;
			else delete shapes[text.id!];
		} else if (value) {
			const id = crypto.randomUUID().slice(0, 8);
			shapes[id] = {
				kind: "text",
				x: text.x,
				y: text.y,
				w: 0,
				h: 0,
				points: [],
				text: value,
				color: ink(),
				z: Date.now(),
			};
			choose(id);
		}
	}
	function remove() {
		if (selected()) delete shapes[selected()];
		choose("");
	}

	/** The board's shapes as an SVG file, cropped to them, on the board's color. */
	function download() {
		const box = layer.getBBox();
		const pad = 32;
		const copy = layer.cloneNode(true) as SVGGElement;
		for (const element of copy.querySelectorAll("[data-hit]")) element.remove();
		for (const element of copy.querySelectorAll("[style], [data-id]")) {
			element.removeAttribute("style");
			element.removeAttribute("data-id");
		}
		const [x, y, w, h] = [
			box.x - pad,
			box.y - pad,
			box.width + 2 * pad,
			box.height + 2 * pad,
		].map(Math.round);
		const file = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#030d14"/>${new XMLSerializer().serializeToString(copy)}</svg>`;
		const link = document.createElement("a");
		link.href = URL.createObjectURL(
			new Blob([file], { type: "image/svg+xml" }),
		);
		link.download = "whiteboard.svg";
		link.click();
		URL.revokeObjectURL(link.href);
	}

	onMount(() => {
		const keys = (event: KeyboardEvent) => {
			if (editing() || (event.target as Element).closest("input")) return;
			if (event.key === "Delete" || event.key === "Backspace") return remove();
			const shortcut = TOOLS.find(([, , , key]) => key === event.key);
			if (shortcut && !event.metaKey && !event.ctrlKey) setTool(shortcut[0]);
		};
		window.addEventListener("keydown", keys);
		onCleanup(() => window.removeEventListener("keydown", keys));
	});

	return (
		<Shell
			title="Whiteboard"
			icon="pen"
			people={pointers.others.map((other) => other.state)}
			pulse={props.pulse}
		>
			<div class={styles.toolbar}>
				<For each={TOOLS}>
					{([name, icon, label, key]) => (
						<button
							type="button"
							title={`${label} (${key.toUpperCase()})`}
							aria-label={label}
							aria-pressed={tool() === name}
							onClick={() => setTool(name)}
						>
							<Icon name={icon} size="1.15rem" />
						</button>
					)}
				</For>
				<span class={styles.separator} />
				<For each={INKS}>
					{(color) => (
						<button
							type="button"
							class={styles.ink}
							style={{ "--ink": color }}
							aria-label={`Color ${color}`}
							aria-pressed={ink() === color}
							onClick={() => {
								setInk(color);
								const shape = shapes[selected()];
								if (shape) shape.color = color;
							}}
						/>
					)}
				</For>
				<span class={styles.separator} />
				<button
					type="button"
					title="Delete the selection (Delete)"
					aria-label="Delete the selection"
					disabled={!selected()}
					onClick={remove}
				>
					<Icon name="trash" size="1.15rem" />
				</button>
				<button
					type="button"
					title="Export as SVG"
					aria-label="Export as SVG"
					disabled={!ids().length}
					onClick={download}
				>
					<Icon name="download" size="1.15rem" />
				</button>
			</div>
			<svg
				ref={svg}
				class={styles.board}
				data-tool={tool()}
				style={{
					"background-size": `${24 * camera().scale}px ${24 * camera().scale}px`,
					"background-position": `${camera().x}px ${camera().y}px`,
				}}
				onPointerDown={down}
				onPointerMove={move}
				onPointerUp={up}
				onPointerLeave={() => {
					pointer = { ...pointer, visible: false };
					share();
				}}
				onWheel={wheel}
				onDblClick={editText}
			>
				<g
					transform={`translate(${camera().x} ${camera().y}) scale(${camera().scale})`}
				>
					<g ref={layer}>
						<For each={ids()}>
							{(id) => (
								<Show when={sketch.shapes[id]}>
									{(shape) => (
										<ShapeView
											id={id}
											shape={shape() as Shape}
											glow={
												selected() === id
													? me.color
													: pointers.others.find(
															(other) => other.state.selected === id,
														)?.state.color
											}
											hidden={editing()?.id === id}
										/>
									)}
								</Show>
							)}
						</For>
					</g>
					<Show when={draft()}>{(shape) => <ShapeView shape={shape()} />}</Show>
					<For each={pointers.others.filter((other) => other.state.visible)}>
						{(other) => (
							<g
								class={styles.cursor}
								transform={`translate(${other.state.x} ${other.state.y}) scale(${1 / camera().scale})`}
							>
								<path
									d="M0 0v17l4.6-4.3 3.2 7 2.6-1.1-3.1-6.8H14Z"
									fill={other.state.color}
									stroke="#fff"
									stroke-width="1.5"
								/>
								<text x="14" y="30" fill={other.state.color}>
									{other.state.name}
								</text>
							</g>
						)}
					</For>
				</g>
			</svg>
			<Show when={editing()}>
				{(text) => (
					<input
						class={styles.text}
						ref={(input) => queueMicrotask(() => input.focus())}
						value={text().text}
						placeholder="Type, then Enter"
						style={{
							left: `${text().x * camera().scale + camera().x}px`,
							top: `${(text().y - FONT_SIZE) * camera().scale + camera().y}px`,
							"font-size": `${FONT_SIZE * camera().scale}px`,
							color: ink(),
						}}
						onInput={(event) =>
							setEditing({ ...text(), text: event.currentTarget.value })
						}
						onKeyDown={(event) => {
							if (event.key === "Enter") commitText();
							if (event.key === "Escape") setEditing(undefined);
						}}
						onBlur={commitText}
					/>
				)}
			</Show>
			<div class={styles.zoom}>
				<button
					type="button"
					aria-label="Zoom out"
					onClick={() => zoom(1 / 1.25)}
				>
					<Icon name="minus" size="1rem" />
				</button>
				<button
					type="button"
					title="Back to 100%"
					onClick={() => setCamera({ x: 0, y: 0, scale: 1 })}
				>
					{Math.round(camera().scale * 100)}%
				</button>
				<button type="button" aria-label="Zoom in" onClick={() => zoom(1.25)}>
					<Icon name="plus" size="1rem" />
				</button>
			</div>
		</Shell>
	);
}

/**
 * One shape, with its look in attributes so that the SVG export keeps it.
 * Thin strokes get a wider invisible twin to be easier to grab.
 */
function ShapeView(props: {
	shape: Shape;
	id?: string;
	glow?: string;
	hidden?: boolean;
}) {
	const stroke = () =>
		({
			stroke: props.shape.color,
			"stroke-width": 3,
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			fill: "none",
		}) as const;
	const hit = (d: string) => (
		<path d={d} data-hit stroke="transparent" stroke-width="16" fill="none" />
	);
	const content = (): JSX.Element => {
		const { kind, x, y, w, h, points, text, color } = props.shape;
		switch (kind) {
			case "rect":
				return (
					<rect
						x={Math.min(x, x + w)}
						y={Math.min(y, y + h)}
						width={Math.abs(w)}
						height={Math.abs(h)}
						rx="8"
						{...stroke()}
					/>
				);
			case "ellipse":
				return (
					<ellipse
						cx={x + w / 2}
						cy={y + h / 2}
						rx={Math.abs(w / 2)}
						ry={Math.abs(h / 2)}
						{...stroke()}
					/>
				);
			case "arrow": {
				const angle = Math.atan2(h, w);
				const head = (side: number) =>
					`${x + w - 16 * Math.cos(angle + side * 0.45)} ${y + h - 16 * Math.sin(angle + side * 0.45)}`;
				const d = `M${x} ${y}L${x + w} ${y + h}M${head(1)}L${x + w} ${y + h}L${head(-1)}`;
				return (
					<>
						<path d={d} {...stroke()} />
						{hit(d)}
					</>
				);
			}
			case "pen": {
				let d = "";
				for (let index = 0; index < points.length; index += 2)
					d += `${index ? "L" : "M"}${x + points[index]!} ${y + points[index + 1]!}`;
				return (
					<>
						<path d={d} {...stroke()} />
						{hit(d)}
					</>
				);
			}
			default:
				return (
					<text
						x={x}
						y={y}
						fill={color}
						font-family={FONT}
						font-size={String(FONT_SIZE)}
						font-weight="500"
					>
						{text}
					</text>
				);
		}
	};
	return (
		<g
			data-id={props.id}
			color={props.shape.color}
			visibility={props.hidden ? "hidden" : undefined}
			style={
				props.glow
					? {
							filter: `drop-shadow(0 0 3px ${props.glow}) drop-shadow(0 0 1px ${props.glow})`,
						}
					: undefined
			}
		>
			{content()}
		</g>
	);
}
