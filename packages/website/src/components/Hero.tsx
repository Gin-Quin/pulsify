import { Button } from "./Button";
import { HeroDiagram } from "./HeroDiagram";
import { GITHUB_URL } from "./links";
import styles from "./Hero.module.css";

export function Hero() {
	return (
		<section class={styles.hero}>
			<img class={styles.planet} src="/images/planet.png" alt="" />
			<div class={styles.inner}>
				<div class={styles.copy}>
					<h1 class={styles.title}>
						Distributed sync,
						<br />
						<span class={styles.gradient}>beautifully composed.</span>
					</h1>
					<p class={styles.lead}>
						The typed CRDT framework. Collaborative documents that look like
						plain objects, migrate themselves and live in your database.
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
