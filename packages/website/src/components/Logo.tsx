import styles from "./Logo.module.css";

export function Logo() {
	return (
		<a class={styles.logo} href="/" aria-label="Pulsify home">
			<img src="/logo-84.png" alt="" width="42" height="42" />
			<span>Pulsify</span>
		</a>
	);
}
