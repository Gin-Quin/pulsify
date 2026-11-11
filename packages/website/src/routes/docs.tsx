import type { RouteSectionProps } from "@solidjs/router";
import { DocsLayout } from "~/components/DocsLayout";

export default function DocsRoot(props: RouteSectionProps) {
	return (
		<main>
			<DocsLayout>{props.children}</DocsLayout>
		</main>
	);
}
