import { Link, Meta, Title } from "@solidjs/meta";
import { useLocation } from "@solidjs/router";
import { Show } from "solid-js";
import { SITE_URL } from "./links";

/** Sections with their own share image in public/og, made by scripts/og-images.sh. */
const sections = ["docs", "cloud", "benchmarks", "pricing"];

/**
 * Title, description, canonical URL and share card of a page. Use it once per
 * page: @solidjs/meta replaces a title but keeps every meta tag whose content differs.
 */
export function Seo(props: {
	title: string;
	description?: string;
	/** Account and error pages: keep them out of search results. */
	noindex?: boolean;
}) {
	const location = useLocation();
	const path = () => location.pathname.replace(/\/$/, "") || "/";
	const url = () => SITE_URL + (path() === "/" ? "/" : path());
	const image = () =>
		`${SITE_URL}/og/${sections.find((section) => path().startsWith(`/${section}`)) ?? "home"}.jpg`;
	return (
		<>
			<Title>{props.title}</Title>
			<Show when={props.description}>
				{(description) => (
					<>
						<Meta name="description" content={description()} />
						<Meta property="og:description" content={description()} />
					</>
				)}
			</Show>
			<Show
				when={!props.noindex}
				fallback={<Meta name="robots" content="noindex" />}
			>
				<Link rel="canonical" href={url()} />
			</Show>
			<Meta property="og:title" content={props.title} />
			<Meta property="og:url" content={url()} />
			<Meta property="og:image" content={image()} />
		</>
	);
}
