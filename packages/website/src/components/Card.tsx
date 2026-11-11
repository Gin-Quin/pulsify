import type { JSX } from "solid-js";
import styles from "./Card.module.css";

export function Card(props: { children: JSX.Element; class?: string }) {
	return (
		<div class={`${styles.card} ${props.class ?? ""}`}>{props.children}</div>
	);
}
