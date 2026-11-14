import { Button } from "~/components/Button";
import { Seo } from "~/components/Seo";

export default function NotFound() {
	return (
		<main
			style={{
				padding: "var(--space-9) var(--space-5)",
				"text-align": "center",
			}}
		>
			<Seo title="Not found · Pulsify" noindex />
			<h1>Page not found</h1>
			<p style={{ margin: "var(--space-4) 0 var(--space-5)" }}>
				That page doesn't exist.
			</p>
			<Button href="/">Back home</Button>
		</main>
	);
}
