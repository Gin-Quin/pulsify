import { For } from "solid-js";
import styles from "./CodeBlock.module.css";

// Tiny highlighter for TS, JSX, Svelte and Vue snippets. The first group that matches names the kind.
// - comment: `//`, `<!-- -->`, and shell `#` followed by a space (so `{#each}` and `#slot` stay code).
// - tag: `<input`, `</ul`, `<ProjectPage`; not `Promise<T>`: an opening tag never follows a word.
// - attr: `bind:value=`, `@click=`, `:key=`, `v-for=`, `onClick=`, and Vue's `#fallback`.
// - keyword: also Svelte blocks `{#each`, `{:else`, `{/if`, `{@html`.
// - fn: `$derived(` keeps its `$`, and `useState<T>(` counts as a call.
const TOKEN = new RegExp(
	[
		String.raw`(?<comment>(?<!:)\/\/.*$|<!--.*?-->|(?<!\S)#(?!\S).*$)`,
		String.raw`(?<string>"[^"]*"|'[^']*'|${"`"}[^${"`"}]*${"`"})`,
		String.raw`(?<tag><\/[A-Za-z][\w.-]*|(?<![\w$])<[A-Za-z][\w.-]*)`,
		String.raw`(?<attr>(?<=\s)(?:[@:]?[A-Za-z][\w:.-]*(?==(?![=>]))|#[\w-]+))`,
		String.raw`(?<keyword>\{[#:/@][a-z]+|\b(?:import|from|const|let|new|await|async|export|type|function|return|if|else|as|default|interface|extends|typeof)\b)`,
		String.raw`(?<number>\b(?:\d+(?:\.\d+)?|true|false|null|undefined)\b)`,
		String.raw`(?<fn>(?<![\w$])[A-Za-z_$][\w$]*(?=(?:<[^()]*>)?\())`,
	].join("|"),
	"gm",
);

function highlight(line: string) {
	const parts: { text: string; kind?: string }[] = [];
	let last = 0;
	for (const m of line.matchAll(TOKEN)) {
		if (m.index > last) parts.push({ text: line.slice(last, m.index) });
		const kind = Object.keys(m.groups!).find((k) => m.groups![k] !== undefined);
		parts.push({ text: m[0], kind });
		last = m.index + m[0].length;
	}
	if (last < line.length) parts.push({ text: line.slice(last) });
	return parts;
}

export function CodeBlock(props: {
	code: string;
	title?: string;
	class?: string;
}) {
	return (
		<figure class={`${styles.window} ${props.class ?? ""}`}>
			<figcaption class={styles.bar}>
				<span class={styles.dots} aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
				{props.title && <span class={styles.tab}>{props.title}</span>}
			</figcaption>
			<pre class={styles.pre}>
				<code>
					<For each={props.code.split("\n")}>
						{(line) => (
							<>
								<For each={highlight(line)}>
									{(part) => <span data-kind={part.kind}>{part.text}</span>}
								</For>
								{"\n"}
							</>
						)}
					</For>
				</code>
			</pre>
		</figure>
	);
}
