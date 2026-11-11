import { useLocation } from "@solidjs/router";
import { Show } from "solid-js";
import { Button } from "./Button";
import { Logo } from "./Logo";
import { GITHUB_URL, JSR_URL } from "./links";
import styles from "./Footer.module.css";

/** Call to action closing every page except the docs. */
export function Footer() {
	const location = useLocation();
	return (
		<Show when={!location.pathname.startsWith("/docs")}>
			<footer class={styles.footer}>
				<img class={styles.mountains} src="/images/mountains.png" alt="" />
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
						<Button href={JSR_URL} variant="outline" icon="external" external>
							jsr.io
						</Button>
						<Button href="/docs" icon="arrow">
							Get Started
						</Button>
					</div>
				</div>
				<small class={styles.copyright}>
					© {new Date().getFullYear()} Pulsify
				</small>
			</footer>
		</Show>
	);
}
