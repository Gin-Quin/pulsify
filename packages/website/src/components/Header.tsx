import { useLocation } from "@solidjs/router";
import { createSignal, For, onMount, Show } from "solid-js";
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
	// After hydration, so the server and client markup match.
	onMount(() => {
		try {
			storeSignedIn(localStorage.getItem("signedIn") === "1");
		} catch {
			// Storage blocked: keep the signed-out button.
		}
	});
	return (
		<header class={styles.header}>
			<div class={styles.inner}>
				<Logo />
				<nav class={styles.nav} aria-label="Main">
					<For
						each={[
							["/benchmarks", "Benchmarks"],
							["/cloud", "Cloud"],
							["/pricing", "Pricing"],
							["/docs", "Docs"],
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
		</header>
	);
}
