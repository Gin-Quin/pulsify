import { getDOMTextNode, type LexicalEditor } from "lexical";
import { type Presence, type Pulse } from "pulsify-core";
import { heldSelections } from "pulsify-core/bindings";
import type { Point } from "./document.js";

export type SelectionState = {
	anchor: string;
	head: string;
	name: string;
	color: string;
};
type Place = { node: Node; offset: number };
type Box = { left: number; top: number; width: number; height: number };

const TEXT = 3;

/** jsdom has no layout: a range has no rectangles there. */
function rangeBoxes(node: Node, from: number, to: number): Box[] {
	const range = node.ownerDocument!.createRange();
	range.setStart(node, from);
	range.setEnd(node, to);
	return typeof range.getClientRects === "function"
		? Array.from(range.getClientRects())
		: [];
}
function nodeBoxes(node: Node): Box[] {
	if (node.nodeType === TEXT) return rangeBoxes(node, 0, (node as Text).length);
	return "getClientRects" in node
		? Array.from((node as Element).getClientRects())
		: [];
}
/** The left or right edge of a box, as a caret. */
const edge = (box: Box, right = false): Box => ({
	left: box.left + (right ? box.width : 0),
	top: box.top,
	width: 0,
	height: box.height,
});

/** Where a caret at this DOM position is drawn, in viewport coordinates. */
function caretBox({ node, offset }: Place): Box {
	if (node.nodeType === TEXT) {
		// Not every browser gives a rectangle to a collapsed range.
		const collapsed = rangeBoxes(node, offset, offset).at(-1);
		if (collapsed) return edge(collapsed);
		const next =
			offset < (node as Text).length
				? rangeBoxes(node, offset, offset + 1)[0]
				: undefined;
		if (next) return edge(next);
		const previous = offset
			? rangeBoxes(node, offset - 1, offset).at(-1)
			: undefined;
		if (previous) return edge(previous, true);
		return edge(node.parentElement!.getBoundingClientRect());
	}
	const next = node.childNodes[offset],
		previous = node.childNodes[offset - 1];
	const before = next && nodeBoxes(next)[0];
	if (before) return edge(before);
	const after = previous && nodeBoxes(previous).at(-1);
	if (after) return edge(after, true);
	return edge((node as Element).getBoundingClientRect());
}

/** One box per line of selected text between two DOM positions. */
function rangeBoxesBetween(a: Place, b: Place): Box[] {
	const document = a.node.ownerDocument!,
		range = document.createRange();
	range.setStart(a.node, a.offset);
	range.setEnd(b.node, b.offset);
	// Setting an end before the start collapses the range onto it.
	if (range.collapsed) {
		range.setStart(b.node, b.offset);
		range.setEnd(a.node, a.offset);
	}
	if (range.collapsed) return [];
	// Only text: a range also reports the whole box of each block it covers.
	const walker = document.createTreeWalker(
		range.commonAncestorContainer,
		4, // NodeFilter.SHOW_TEXT
	);
	walker.currentNode = range.startContainer;
	const boxes: Box[] = [];
	let started = false;
	for (
		let node: Node | null =
			range.startContainer.nodeType === TEXT
				? range.startContainer
				: walker.nextNode();
		node;
		node = walker.nextNode()
	) {
		if (!range.intersectsNode(node)) {
			if (started) break;
			continue;
		}
		started = true;
		const from = node === range.startContainer ? range.startOffset : 0,
			to =
				node === range.endContainer ? range.endOffset : (node as Text).length;
		if (from < to)
			for (const box of rangeBoxes(node, from, to))
				if (box.width && box.height) boxes.push(box);
	}
	return boxes;
}

/** A stable color for a peer that did not choose one. */
const peerColor = (peer: number): string =>
	`hsl(${Math.round((peer * 137.508) % 360)}, 70%, 45%)`;

/**
 * Draw the caret and the selected range of every other peer over the editor.
 * Lexical has no decorations, so they are elements positioned over the text,
 * in a layer that is a child of `target` or of the parent of the root element.
 */
export function drawSelections(
	editor: LexicalEditor,
	pulse: Pulse<any>,
	presence: Presence<SelectionState>,
	pointOf: (anchor: string) => Point | undefined,
	target?: HTMLElement,
): { schedule(): void; destroy(): void } {
	let root: HTMLElement | null = null,
		layer: HTMLElement | undefined,
		observer: ResizeObserver | undefined,
		frame: number | undefined,
		destroyed = false;
	const view = () => root?.ownerDocument.defaultView ?? undefined;
	const place = (point: Point): Place | undefined => {
		const element = editor.getElementByKey(point.key);
		if (!element) return undefined;
		const text = point.type === "text" ? getDOMTextNode(element) : null;
		return text
			? { node: text, offset: Math.min(point.offset, text.length) }
			: {
					node: element,
					offset:
						point.type === "text"
							? 0
							: Math.min(point.offset, element.childNodes.length),
				};
	};
	// A peer whose characters have not arrived yet keeps its last selection.
	const held = heldSelections(
		pulse,
		(state: SelectionState) => {
			const anchor = pointOf(state.anchor),
				head = pointOf(state.head);
			const from = anchor && place(anchor),
				to = head && place(head);
			return from && to ? { from, to } : undefined;
		},
		() => schedule(),
	);
	const draw = () => {
		frame = undefined;
		const container = target ?? root?.parentElement;
		const peers =
			destroyed || !root || !container
				? []
				: held
						.resolve(presence.others)
						.map(({ peer, state, resolved }) => ({ peer, state, ...resolved }));
		// Nothing of this binding is in the page while there is nothing to show.
		if (!root || !container || !peers.length) {
			layer?.remove();
			layer = undefined;
			return;
		}
		const document = root.ownerDocument;
		if (!layer) {
			layer = document.createElement("div");
			layer.setAttribute("data-pulsify-cursors", "");
			layer.setAttribute("aria-hidden", "true");
			layer.style.cssText =
				"position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;user-select:none;";
		}
		if (layer.parentNode !== container) container.appendChild(layer);
		// Measured, so it holds whatever the container's own positioning is.
		const origin = layer.getBoundingClientRect();
		const box = (peer: number, { left, top, width, height }: Box) => {
			const element = document.createElement("div");
			element.style.cssText = `position:absolute;left:${left - origin.left}px;top:${top - origin.top}px;width:${width}px;height:${height}px;pointer-events:none;`;
			element.style.backgroundColor = peerColor(peer);
			return element;
		};
		const elements: HTMLElement[] = [];
		for (const { peer, state, from, to } of peers) {
			for (const selected of rangeBoxesBetween(from, to)) {
				const element = box(peer, selected);
				element.setAttribute("data-peer-selection", String(peer));
				// An invalid color is ignored and leaves the peer's own.
				if (state.color) element.style.backgroundColor = state.color;
				element.style.opacity = "0.25";
				elements.push(element);
			}
			const caret = box(peer, { ...caretBox(to), width: 2 });
			caret.setAttribute("data-peer", String(peer));
			caret.style.marginLeft = "-1px";
			if (state.color) caret.style.backgroundColor = state.color;
			if (state.name) {
				const label = document.createElement("div");
				label.textContent = state.name;
				label.style.cssText =
					"position:absolute;left:0;bottom:100%;padding:0 4px;border-radius:3px 3px 3px 0;font:600 11px/1.5 system-ui,sans-serif;color:#fff;white-space:nowrap;pointer-events:none;";
				label.style.backgroundColor = caret.style.backgroundColor;
				caret.appendChild(label);
			}
			elements.push(caret);
		}
		layer.replaceChildren(...elements);
	};
	/** Once per frame in a browser; at once where there are no frames. */
	const schedule = () => {
		if (destroyed || frame !== undefined) return;
		const window = view();
		if (window?.requestAnimationFrame)
			frame = window.requestAnimationFrame(draw);
		else draw();
	};
	const onScroll = (event: Event) => {
		const scrolled = event.target as Node | null;
		if (
			root &&
			scrolled &&
			(scrolled.contains(root) || root.contains(scrolled))
		)
			schedule();
	};
	const watch = (next: HTMLElement | null) => {
		observer?.disconnect();
		observer = undefined;
		root?.ownerDocument.removeEventListener("scroll", onScroll, true);
		if (frame !== undefined) view()?.cancelAnimationFrame(frame);
		frame = undefined;
		root = destroyed ? null : next;
		if (root) {
			const Observer = view()?.ResizeObserver;
			if (Observer) {
				observer = new Observer(schedule);
				observer.observe(root);
			}
			// What scrolls inside the container moves the text under the layer.
			root.ownerDocument.addEventListener("scroll", onScroll, true);
		}
		draw();
	};
	const stopRoot = editor.registerRootListener((next) => watch(next));
	const stopPresence = presence.subscribe(schedule);
	return {
		schedule,
		destroy() {
			if (destroyed) return;
			destroyed = true;
			held.destroy();
			stopPresence();
			stopRoot();
			watch(null);
		},
	};
}
