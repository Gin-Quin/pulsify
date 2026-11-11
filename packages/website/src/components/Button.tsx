import type { JSX } from "solid-js";
import { Icon, type IconName } from "./Icon";
import styles from "./Button.module.css";

export function Button(props: {
	href: string;
	variant?: "primary" | "outline";
	icon?: IconName;
	iconPosition?: "start" | "end";
	external?: boolean;
	size?: "sm" | "md";
	children: JSX.Element;
}) {
	const icon = () => props.icon && <Icon name={props.icon} size="1.1em" />;
	return (
		<a
			class={styles.button}
			data-variant={props.variant ?? "primary"}
			data-size={props.size ?? "md"}
			href={props.href}
			target={props.external ? "_blank" : undefined}
			rel={props.external ? "noopener noreferrer" : undefined}
		>
			{props.iconPosition === "start" && icon()}
			{props.children}
			{props.iconPosition !== "start" && icon()}
		</a>
	);
}
