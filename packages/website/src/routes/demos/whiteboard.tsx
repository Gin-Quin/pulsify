import { clientOnly } from "@solidjs/start";
import { Seo } from "~/components/Seo";

// The demo loads its pulses in the browser only.
const Whiteboard = clientOnly(() => import("~/demo/Whiteboard"));

export default function WhiteboardPage() {
	return (
		<>
			<Seo
				title="Whiteboard · Pulsify demo"
				description="A shared whiteboard: draw shapes and text, zoom, and export to SVG."
				noindex
			/>
			<Whiteboard />
		</>
	);
}
