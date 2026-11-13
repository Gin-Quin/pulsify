import type { RouteSectionProps } from "@solidjs/router";
import docs from "~/components/Docs.module.css";

/** Terms, privacy, DPA and legal notice: the prose style of the docs, one column. */
export default function LegalRoot(props: RouteSectionProps) {
	return (
		<main>
			<article
				class={docs.content}
				style={{
					"max-width": "48rem",
					margin: "0 auto",
					padding: "var(--space-7) var(--space-5) var(--space-8)",
				}}
			>
				{props.children}
			</article>
		</main>
	);
}
