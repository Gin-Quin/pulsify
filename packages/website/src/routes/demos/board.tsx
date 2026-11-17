import { clientOnly } from "@solidjs/start";
import { Seo } from "~/components/Seo";

// The demo loads its pulses in the browser only.
const Board = clientOnly(() => import("~/demo/Board"));

export default function BoardPage() {
	return (
		<>
			<Seo
				title="Board · Pulsify demo"
				description="A shared kanban board: create cards and move them between columns."
				noindex
			/>
			<Board />
		</>
	);
}
