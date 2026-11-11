import { useLocation } from "@solidjs/router";
import {
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type JSX,
} from "solid-js";
import { docsNav } from "./docsNav";
import styles from "./Docs.module.css";

export function DocsLayout(props: { children: JSX.Element }) {
	const location = useLocation();
	const path = () => location.pathname.replace(/\/$/, "") || "/";
	const index = () => docsNav.findIndex((page) => page.href === path());
	const previous = () => docsNav[index() - 1];
	const next = () => docsNav[index() + 1];
	const [sections, setSections] = createSignal<{ id: string; title: string }[]>(
		[],
	);
	const [active, setActive] = createSignal<string>();
	let article!: HTMLElement;

	// The active section is the last h2 above the top third of the viewport.
	const track = () => {
		const headings = article.querySelectorAll("h2");
		const bottom =
			window.innerHeight + window.scrollY >=
			document.documentElement.scrollHeight - 2;
		let current: string | undefined;
		for (const heading of headings)
			if (bottom || heading.getBoundingClientRect().top <= window.innerHeight / 3)
				current = heading.id;
		setActive(current);
	};
	// Pages render lazily, so collect headings whenever the article changes.
	const collect = () => {
		setSections(
			Array.from(article.querySelectorAll("h2"), (heading) => {
				const title = heading.textContent ?? "";
				heading.id ||= slug(title);
				return { id: heading.id, title };
			}),
		);
		track();
	};
	onMount(() => {
		const observer = new MutationObserver(collect);
		observer.observe(article, { childList: true, subtree: true });
		window.addEventListener("scroll", track, { passive: true });
		collect();
		onCleanup(() => {
			observer.disconnect();
			window.removeEventListener("scroll", track);
		});
	});
	return (
		<div class={styles.layout}>
			<nav class={styles.sidebar} aria-label="Documentation">
				<For each={docsNav}>
					{(page, i) => (
						<>
							<Show when={page.section !== docsNav[i() - 1]?.section && page.section}>
								{(section) => <span class={styles.section}>{section()}</span>}
							</Show>
							<a href={page.href} aria-current={path() === page.href ? "page" : undefined}>
								{page.title}
							</a>
							<Show when={path() === page.href && sections().length}>
								<div class={styles.sections}>
									<For each={sections()}>
										{(section) => (
											<a
												href={`#${section.id}`}
												aria-current={
													active() === section.id ? "location" : undefined
												}
											>
												{section.title}
											</a>
										)}
									</For>
								</div>
							</Show>
						</>
					)}
				</For>
			</nav>
			<article ref={article} class={styles.content}>
				{props.children}
				<nav class={styles.pager} aria-label="Pages">
					<Show when={previous()} fallback={<span />}>
						{(page) => (
							<a href={page().href}>
								<small>Previous</small>
								{page().title}
							</a>
						)}
					</Show>
					<Show when={next()}>
						{(page) => (
							<a href={page().href} class={styles.next}>
								<small>Next</small>
								{page().title}
							</a>
						)}
					</Show>
				</nav>
			</article>
		</div>
	);
}

/** Callout for a short note or warning inside the docs. */
export function Note(props: { kind?: "info" | "warn"; children: JSX.Element }) {
	return (
		<aside class={styles.note} data-kind={props.kind ?? "info"}>
			{props.children}
		</aside>
	);
}

function slug(text: string) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}
