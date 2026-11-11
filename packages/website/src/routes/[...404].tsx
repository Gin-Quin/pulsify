import { Button } from "~/components/Button";
import { Title } from "@solidjs/meta";

export default function NotFound() {
	return (
		<main
			style={{
				padding: "var(--space-9) var(--space-5)",
				"text-align": "center",
			}}
		>
			<Title>Not found · Pulsify</Title>
			<h1>Page not found</h1>
			<p style={{ margin: "var(--space-4) 0 var(--space-5)" }}>
				That page doesn't exist.
			</p>
			<Button href="/">Back home</Button>
		</main>
	);
}
