import { clientOnly } from "@solidjs/start";
import { Seo } from "~/components/Seo";

// The demo loads its pulses in the browser only.
const Docs = clientOnly(() => import("~/demo/Docs"));

export default function DocsPage() {
	return (
		<>
			<Seo
				title="Docs · Pulsify demo"
				description="Collaborative documents with live cursors, on Pulsify and ProseMirror."
				noindex
			/>
			<Docs />
		</>
	);
}
