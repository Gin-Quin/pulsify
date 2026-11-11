import { createSignal, For, type JSX } from "solid-js";
import styles from "./Tabs.module.css";

export function Tabs(props: {
	tabs: { label: string; content: JSX.Element }[];
}) {
	const [active, setActive] = createSignal(0);
	return (
		<div class={styles.tabs}>
			<div class={styles.list} role="tablist">
				<For each={props.tabs}>
					{(tab, index) => (
						<button
							type="button"
							role="tab"
							class={styles.tab}
							aria-selected={active() === index()}
							onClick={() => setActive(index())}
						>
							{tab.label}
						</button>
					)}
				</For>
			</div>
			<div role="tabpanel">{props.tabs[active()]?.content}</div>
		</div>
	);
}
