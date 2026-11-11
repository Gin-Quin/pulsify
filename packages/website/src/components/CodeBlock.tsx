import { For } from "solid-js";
import styles from "./CodeBlock.module.css";

const TOKEN =
	/(\/\/.*$|#.*$)|("[^"]*"|'[^']*'|`[^`]*`)|\b(import|from|const|let|new|await|async|export|type|function|return|if|else|as|default|interface|extends|typeof)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)(?=\()/gm;

// Tiny highlighter: comments, strings, keywords, numbers and calls. Enough for snippets.
function highlight(line: string) {
	const parts: { text: string; kind?: string }[] = [];
	let last = 0;
	for (const m of line.matchAll(TOKEN)) {
		if (m.index > last) parts.push({ text: line.slice(last, m.index) });
		const kind = m[1]
			? "comment"
			: m[2]
				? "string"
				: m[3]
					? "keyword"
					: m[4]
						? "number"
						: "fn";
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
