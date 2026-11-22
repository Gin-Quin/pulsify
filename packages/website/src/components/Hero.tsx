import { Button } from "./Button";
import { HeroDiagram } from "./HeroDiagram";
import { GITHUB_URL } from "./links";
import styles from "./Hero.module.css";

export function Hero() {
	return (
		<section class={styles.hero}>
			<img class={styles.planet} src="/images/planet.webp" alt="" />
			<div class={styles.inner}>
				<div class={styles.copy}>
					<h1 class={styles.title}>
						The sync engine
						<br />
						<span class={styles.gradient}>for local-first apps.</span>
					</h1>
					<p class={styles.lead}>
						Pulsify turns plain TypeScript objects into typed, collaborative
						CRDTs. Self-host sync on your own database, or run it serverless on
						Pulsify Cloud.
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
				<div class={styles.visual}>
					<HeroDiagram />
				</div>
			</div>
		</section>
	);
}
