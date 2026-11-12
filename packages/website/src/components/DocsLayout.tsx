import { useLocation } from "@solidjs/router";
import {
	createEffect,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type JSX,
} from "solid-js";
import { docsNav, docsPages, type DocsPage } from "./docsNav";
import { Icon } from "./Icon";
import styles from "./Docs.module.css";

export function DocsLayout(props: { children: JSX.Element }) {
	const location = useLocation();
	const path = () => location.pathname.replace(/\/$/, "") || "/";
	const index = () => docsPages.findIndex((page) => page.href === path());
	const previous = () => docsPages[index() - 1];
	const next = () => docsPages[index() + 1];
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
			if (
				bottom ||
				heading.getBoundingClientRect().top <= window.innerHeight / 3
			)
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
	const sectionLinks = () => (
		<For each={sections()}>
			{(section, i) => (
				<a
					style={{ "--i": i() }}
					href={`#${section.id}`}
					aria-current={active() === section.id ? "location" : undefined}
					onClick={(event) => {
						if (
							event.defaultPrevented ||
							event.button !== 0 ||
							event.metaKey ||
							event.altKey ||
							event.ctrlKey ||
							event.shiftKey ||
							location.hash !== `#${section.id}`
						)
							return;
						// The router skips navigation when the hash is unchanged.
						event.preventDefault();
						document
							.getElementById(section.id)
							?.scrollIntoView({ block: "start" });
					}}
				>
					{section.title}
				</a>
			)}
		</For>
	);
	const link = (page: DocsPage) => (
		<>
			<a
				href={page.href}
				aria-current={path() === page.href ? "page" : undefined}
			>
				{page.title}
			</a>
			{/* Narrow screens: the sections unfold under the current page. */}
			<Show when={path() === page.href && sections().length}>
				<div class={styles.sections}>{sectionLinks()}</div>
			</Show>
		</>
	);
	return (
		<div class={styles.layout}>
			<nav class={styles.sidebar} aria-label="Documentation">
				<For each={docsNav}>
					{(entry) => {
						if (!("group" in entry)) return link(entry);
						const [open, setOpen] = createSignal(
							entry.pages.some((page) => page.href === path()),
						);
						// Reveal the current page without closing other groups.
						createEffect(() => {
							if (entry.pages.some((page) => page.href === path()))
								setOpen(true);
						});
						return (
							<details
								class={styles.group}
								open={open()}
								onToggle={(event) => setOpen(event.currentTarget.open)}
							>
								<summary>{entry.group}</summary>
								<div class={styles.pages}>
									<For each={entry.pages}>{link}</For>
								</div>
							</details>
						);
					}}
				</For>
			</nav>
			<article ref={article} class={styles.content}>
				{props.children}
				<nav class={styles.pager} aria-label="Pages">
					<Show when={previous()} fallback={<span />}>
						{(page) => (
							<a href={page().href}>
								<small>
									<Icon name="arrow" size="1em" class={styles.flipped} />
									Previous
								</small>
								{pagerTitle(page())}
							</a>
						)}
					</Show>
					<Show when={next()}>
						{(page) => (
							<a href={page().href} class={styles.next}>
								<small>
									Next
									<Icon name="arrow" size="1em" />
								</small>
								{pagerTitle(page())}
							</a>
						)}
					</Show>
				</nav>
			</article>
			{/* Wide screens: the sections of the page stay in view on the right. */}
			<aside class={styles.toc} aria-label="On this page">
				<Show when={sections().length}>
					<span>On this page</span>
					<div>{sectionLinks()}</div>
				</Show>
			</aside>
		</div>
	);
}

/** Callout for a short note or warning inside the docs. */
export function Note(props: {
	kind?: "info" | "warn" | "danger";
	children: JSX.Element;
}) {
	return (
		<aside class={styles.note} data-kind={props.kind ?? "info"}>
			{props.children}
		</aside>
	);
}

/** "Authentication" exists twice: the pager names the group too. */
function pagerTitle(page: DocsPage & { group?: string }) {
	return page.group ? `${page.group} · ${page.title}` : page.title;
}

function slug(text: string) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}
