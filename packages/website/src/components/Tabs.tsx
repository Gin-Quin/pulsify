import { createSignal, createUniqueId, For, type JSX } from "solid-js";
import styles from "./Tabs.module.css";

export function Tabs(props: {
	tabs: { label: string; content: JSX.Element }[];
}) {
	const [active, setActive] = createSignal(0);
	// Stable through hydration: names each tab and the panel it controls.
	const id = createUniqueId();
	// Read once: each read of the prop would build every tab's content again.
	const tabs = props.tabs;
	return (
		<div class={styles.tabs}>
			<div class={styles.list} role="tablist">
				<For each={tabs}>
					{(tab, index) => (
						<button
							type="button"
							role="tab"
							id={`${id}-tab-${index()}`}
							aria-controls={`${id}-panel-${index()}`}
							class={styles.tab}
							aria-selected={active() === index()}
							onClick={() => setActive(index())}
						>
							{tab.label}
						</button>
					)}
				</For>
			</div>
			{/* Every panel is rendered, so the server HTML and hydration agree. */}
			<For each={tabs}>
				{(tab, index) => (
					<div
						role="tabpanel"
						id={`${id}-panel-${index()}`}
						aria-labelledby={`${id}-tab-${index()}`}
						hidden={active() !== index()}
					>
						{tab.content}
					</div>
				)}
			</For>
		</div>
	);
}
