import { useLocation } from "@solidjs/router";
import { Show } from "solid-js";
import { Button } from "./Button";
import { Logo } from "./Logo";
import { GITHUB_URL } from "./links";
import styles from "./Footer.module.css";

/** Call to action closing every page except the docs. */
export function Footer() {
	const location = useLocation();
	// The dashboard keeps the mountains only.
	const bare = () => location.pathname.startsWith("/dashboard");
	return (
		<Show when={!location.pathname.startsWith("/docs")}>
			<footer class={styles.footer} classList={{ [styles.bare]: bare() }}>
				<img class={styles.mountains} src="/images/mountains.webp" alt="" />
				<Show when={!bare()}>
					<div class={styles.inner}>
						<Logo />
						<h2 class={styles.title}>
							Build synchronized experiences with{" "}
							<span class={styles.accent}>Pulsify.</span>
						</h2>
						<p class={styles.lead}>
							Typed collaborative documents for modern applications.
						</p>
						<div class={styles.actions}>
							<Button
								href={GITHUB_URL}
								variant="outline"
								icon="github"
								iconPosition="start"
								external
							>
								View on GitHub
							</Button>
							<Button href="/docs" icon="arrow">
								Get Started
							</Button>
						</div>
					</div>
					<small class={styles.copyright}>
						© {new Date().getFullYear()} Pulsify ·{" "}
						<a href="/legal/terms">Terms</a> ·{" "}
						<a href="/legal/privacy">Privacy</a> · <a href="/legal">Legal</a>
					</small>
				</Show>
			</footer>
		</Show>
	);
}
