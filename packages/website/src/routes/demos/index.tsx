import { For } from "solid-js";
import { Icon, type IconName } from "~/components/Icon";
import { Seo } from "~/components/Seo";
import { Sky } from "~/components/Sky";
import button from "~/components/Button.module.css";
import card from "~/components/Card.module.css";
import styles from "~/components/Cloud.module.css";

const demos: { id: string; icon: IconName; title: string; text: string }[] = [
	{
		id: "pong",
		icon: "paddle",
		title: "Pong",
		text: "Two players, one ball. Paddles and ball travel through presence at 60 updates a second; only the score is stored.",
	},
	{
		id: "docs",
		icon: "file",
		title: "Docs",
		text: "Rich text documents edited together, with everyone's cursor and selection, and who has which document open.",
	},
	{
		id: "whiteboard",
		icon: "pen",
		title: "Whiteboard",
		text: "Draw shapes, arrows and text on an endless board, see the others' pointers, zoom, and export it as SVG.",
	},
	{
		id: "board",
		icon: "columns",
		title: "Board",
		text: "Four columns of cards to create, rename and drag around. Concurrent moves never duplicate or lose a card.",
	},
];

export default function Demos() {
	return (
		<Sky>
			<main class={styles.starryTop}>
				<Seo
					title="Demos · Pulsify"
					description="Four collaborative apps on Pulsify Cloud: Pong, Docs, a whiteboard and a kanban board. Open one in two windows and watch them sync."
				/>
				<section class={`${styles.section} ${styles.plansHead}`}>
					<h1 class={styles.title}>
						See it sync{" "}
						<span class={styles.gradient}>live on Pulsify Cloud.</span>
					</h1>
					<div class={styles.demosLead}>
						<p>Build safe, collaborative apps in minutes with Pulsify Cloud.</p>
						<p>
							Open one, then open its link in a second window or scan its QR
							code with your phone. Go offline, keep editing, and watch
							everything merge when you come back.
						</p>
					</div>
					<div class={`${styles.grid} ${styles.demos}`}>
						<For each={demos}>
							{(demo) => (
								// The whole card is the link; its button is only the look of one.
								<a
									class={`${card.card} ${styles.feature} ${styles.demoCard}`}
									href={`/demos/${demo.id}`}
									target="_blank"
									rel="noopener"
									data-button-hover
								>
									<div class={styles.shotFrame}>
										<img
											class={styles.shot}
											src={`/images/demos/${demo.id}.webp`}
											alt={`The ${demo.title} demo, used by two people at once`}
											width="1280"
											height="800"
											loading="lazy"
										/>
									</div>
									<h2 class={`${styles.featureTitle} ${styles.demoTitle}`}>
										<Icon name={demo.icon} size="1.3rem" class={styles.icon} />
										{demo.title}
									</h2>
									<p class={styles.text}>{demo.text}</p>
									<div class={styles.demoAction}>
										<span
											class={button.button}
											data-variant="primary"
											data-size="sm"
										>
											Open {demo.title}
											<Icon name="external" size="1.1em" />
										</span>
									</div>
								</a>
							)}
						</For>
					</div>
				</section>
			</main>
		</Sky>
	);
}
