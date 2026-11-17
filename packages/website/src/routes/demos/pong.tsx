import { clientOnly } from "@solidjs/start";
import { Seo } from "~/components/Seo";

// The demo loads its pulses in the browser only.
const Pong = clientOnly(() => import("~/demo/Pong"));

export default function PongPage() {
	return (
		<>
			<Seo
				title="Pong · Pulsify demo"
				description="Two players, one ball: paddles and ball move through presence at 60 updates a second."
				noindex
			/>
			<Pong />
		</>
	);
}
