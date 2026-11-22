import { useLocation } from "@solidjs/router";
import {
	createEffect,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { GITHUB_URL } from "./links";
import styles from "./Header.module.css";

/** The theme is a docs setting: tokens.css applies it only where this toggle shows. */
function toggleTheme() {
	const root = document.documentElement;
	const theme = root.dataset.theme === "light" ? "dark" : "light";
	root.dataset.theme = theme;
	// Read back by the inline script in entry-server.tsx on the next load.
	try {
		localStorage.setItem("theme", theme);
	} catch {
		// Storage blocked: the choice lasts for this page only.
	}
}

const [signedIn, storeSignedIn] = createSignal(false);

/**
 * The session cookie is HttpOnly on the API domain, so the dashboard records
 * whether it found a session here, for the header of every page.
 */
export function setSignedIn(value: boolean) {
	storeSignedIn(value);
	try {
		if (value) localStorage.setItem("signedIn", "1");
		else localStorage.removeItem("signedIn");
	} catch {
		// Storage blocked: the header shows the signed-out button.
	}
}

export function Header() {
	const location = useLocation();
	const [menuOpen, setMenuOpen] = createSignal(false);
	let header!: HTMLElement;
	let menuToggle!: HTMLButtonElement;

	createEffect(
		on(
			() => location.pathname,
			() => setMenuOpen(false),
		),
	);

	// After hydration, so the server and client markup match.
	onMount(() => {
		const dismissOutside = (event: PointerEvent) => {
			if (menuOpen() && !header.contains(event.target as Node)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("pointerdown", dismissOutside);
		onCleanup(() =>
			document.removeEventListener("pointerdown", dismissOutside),
		);

		try {
			storeSignedIn(localStorage.getItem("signedIn") === "1");
		} catch {
			// Storage blocked: keep the signed-out button.
		}
	});
	return (
		<header
			ref={header}
			class={styles.header}
			onKeyDown={(event) => {
				if (event.key === "Escape" && menuOpen()) {
					setMenuOpen(false);
					menuToggle.focus();
				}
			}}
			onFocusOut={(event) => {
				const next = event.relatedTarget;
				if (next instanceof Node && !event.currentTarget.contains(next)) {
					setMenuOpen(false);
				}
			}}
			onClick={(event) => {
				if (
					menuOpen() &&
					event.target instanceof Element &&
					event.target.closest("a")
				) {
					setMenuOpen(false);
					menuToggle.focus();
				}
			}}
		>
			<div class={styles.inner}>
				<Logo />
				<button
					ref={menuToggle}
					class={styles.menuToggle}
					type="button"
					aria-label="Navigation menu"
					aria-expanded={menuOpen()}
					aria-controls="header-menu"
					onClick={(event) => {
						setMenuOpen(!menuOpen());
						event.currentTarget.focus();
					}}
				>
					<Icon name={menuOpen() ? "cross" : "menu"} />
				</button>
				<div id="header-menu" class={styles.panel} data-open={menuOpen()}>
					<nav class={styles.nav} aria-label="Main">
						<For
							each={[
								["/cloud", "Cloud"],
								["/demos", "Demos"],
								["/pricing", "Pricing"],
								["/docs", "Docs"],
								["/benchmarks", "Benchmarks"],
							]}
						>
							{([href, label]) => (
								<a
									href={href}
									aria-current={
										location.pathname === href ||
										location.pathname.startsWith(`${href}/`)
											? "page"
											: undefined
									}
								>
									<span>{label}</span>
								</a>
							)}
						</For>
					</nav>
					<div class={styles.actions}>
						<Show when={location.pathname.startsWith("/docs")}>
							<button
								class={styles.theme}
								type="button"
								aria-label="Switch between light and dark theme"
								data-theme-toggle
								onClick={toggleTheme}
							>
								<Icon name="sun" class={styles.sun} />
								<Icon name="moon" class={styles.moon} />
							</button>
						</Show>
						<a
							class={styles.github}
							href={GITHUB_URL}
							target="_blank"
							rel="noopener noreferrer"
						>
							<Icon name="github" />
							<span>GitHub</span>
						</a>
						<Show
							when={signedIn()}
							fallback={
								<Button href="/sign-in" size="sm" icon="arrow">
									Get Started
								</Button>
							}
						>
							<Button href="/dashboard" size="sm" variant="outline">
								Dashboard
							</Button>
						</Show>
					</div>
				</div>
			</div>
		</header>
	);
}
