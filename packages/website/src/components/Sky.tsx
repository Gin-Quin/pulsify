import { For, type JSX } from "solid-js";
import { Footer } from "./Footer";
import styles from "./Sky.module.css";

/* [sprite, left %, top %, size px] */
const stars = [
	[1, 88, 3, 44],
	[3, 94, 27, 52],
	[4, 3, 41, 40],
	[5, 90, 55, 36],
	[1, 95, 80, 40],
] as const;

/** Faint starfield behind a page, down to and including its footer. */
export function Sky(props: { children: JSX.Element }) {
	return (
		<div class={styles.sky}>
			<div class={styles.stars} aria-hidden="true">
				<For each={stars}>
					{([n, left, top, size]) => (
						<img
							src={`/images/star-${n}.png`}
							alt=""
							style={{ left: `${left}%`, top: `${top}%`, width: `${size}px` }}
						/>
					)}
				</For>
			</div>
			{props.children}
			<Footer />
		</div>
	);
}
