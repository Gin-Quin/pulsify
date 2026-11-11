import { useLocation } from "@solidjs/router";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { GITHUB_URL } from "./links";
import styles from "./Header.module.css";

export function Header() {
	const location = useLocation();
	return (
		<header class={styles.header}>
			<div class={styles.inner}>
				<Logo />
				<nav class={styles.nav} aria-label="Main">
					<a href="/#why">Why</a>
					<a href="/benchmarks" aria-current={location.pathname === "/benchmarks" ? "page" : undefined}>Benchmarks</a>
					<a href="/cloud">Cloud</a>
					<a href="/docs">Docs</a>
				</nav>
				<div class={styles.actions}>
					<a
						class={styles.github}
						href={GITHUB_URL}
						target="_blank"
						rel="noopener noreferrer"
					>
						<Icon name="github" />
						<span>GitHub</span>
					</a>
					<Button href="/docs/getting-started" size="sm" icon="arrow">
						Get Started
					</Button>
				</div>
			</div>
		</header>
	);
}
