// After `vite build`: sitemap.xml, plus llms.txt, llms-full.txt and a Markdown
// copy of every docs page for AI agents, all read from the prerendered HTML.
import { Glob } from "bun";
import { docsPages } from "../src/components/docsNav";
import { GITHUB_URL, SITE_URL } from "../src/components/links";

const root = new URL("../.output/public/", import.meta.url).pathname;

type Page = { path: string; title: string; description: string; html: string };
const pages = new Map<string, Page>();
for await (const file of new Glob("**/index.html").scan(root)) {
	const html = await Bun.file(root + file).text();
	if (/<meta[^>]*name="robots"[^>]*noindex/.test(html)) continue;
	const path = `/${file.replace(/\/?index\.html$/, "")}`;
	pages.set(path, {
		path,
		title: decode(html.match(/<title[^>]*>([^<]*)/)?.[1] ?? path),
		description: decode(
			html.match(/<meta[^>]*name="description" content="([^"]*)"/)?.[1] ?? "",
		),
		html,
	});
}
const sorted = [...pages.values()].sort((a, b) => a.path.localeCompare(b.path));

await Bun.write(
	root + "sitemap.xml",
	`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sorted.map((page) => `  <url><loc>${SITE_URL}${page.path === "/" ? "/" : page.path}</loc></url>`).join("\n")}
</urlset>
`,
);

// Docs in reading order, each also served as Markdown at <path>.md.
const docs = docsPages.map((entry) => {
	const page = pages.get(entry.href);
	if (!page) throw new Error(`${entry.href} was not prerendered`);
	const article = page.html.match(/<article[^>]*>([\s\S]*?)<\/article>/)?.[1];
	if (!article) throw new Error(`${entry.href} has no <article>`);
	return { ...page, group: entry.group, markdown: markdown(article) };
});
for (const page of docs)
	await Bun.write(`${root}${page.path.slice(1)}.md`, page.markdown);

const home = pages.get("/")!;
const link = (page: Page, suffix = "") =>
	`- [${page.title.replace(/ · .*/, "")}](${SITE_URL}${page.path}${suffix})${page.description ? `: ${page.description}` : ""}`;
const others = ["/benchmarks", "/cloud", "/pricing", "/legal"].flatMap(
	(path) => pages.get(path) ?? [],
);
await Bun.write(
	root + "llms.txt",
	`# Pulsify

> ${home.description}

Install it with \`bun add pulsify-core\` (or npm, pnpm, yarn). Framework bindings ship as pulsify-react, pulsify-vue, pulsify-solid and pulsify-svelte. Source: ${GITHUB_URL}. Every docs page below is Markdown; ${SITE_URL}/llms-full.txt has all of them in one file.

## Docs

${docs.map((page) => link(page, ".md")).join("\n")}

## Optional

${others.map((page) => link(page)).join("\n")}
`,
);
await Bun.write(
	root + "llms-full.txt",
	docs
		.map((page) => `<!-- ${SITE_URL}${page.path} -->\n\n${page.markdown}`)
		.join("\n\n"),
);
console.log(
	`seo-files: ${sorted.length} URLs in the sitemap, ${docs.length} docs pages as Markdown`,
);

// ponytail: regexes over our own prerendered markup, not a general HTML parser;
// a new kind of element in the docs only needs one more replace here.
function markdown(html: string) {
	const text = (s: string) => s.replace(/<[^>]+>/g, "");
	const fence: Record<string, string> = {
		terminal: "sh",
		ts: "ts",
		tsx: "tsx",
		svelte: "svelte",
		vue: "vue",
		json: "json",
	};
	const tabs = new Map(
		[
			...html.matchAll(
				/<button[^>]*role="tab"[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g,
			),
		].map((m) => [m[1], m[2]] as const),
	);
	const out = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<svg[\s\S]*?<\/svg>/g, "")
		// Tabs: drop the buttons, and title each panel with its button's label.
		.replace(/<div[^>]*role="tablist"[\s\S]*?<\/div>/g, "")
		.replace(
			/<div[^>]*role="tabpanel"[^>]*aria-labelledby="([^"]*)"[^>]*>/g,
			(_, id) => `\n\n**${text(tabs.get(id) ?? "")}**\n\n`,
		)
		.replace(/<figure[^>]*>([\s\S]*?)<\/figure>/g, (_, inner: string) => {
			const caption = text(
				inner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/)?.[1] ?? "",
			).trim();
			const code = inner.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1];
			if (code === undefined) return caption ? `\n\n_${caption}_\n\n` : "";
			const lang = fence[caption.split(".").pop()!] ?? "";
			return `\n\n\`\`\`${lang}${caption && caption !== "terminal" ? ` title="${caption}"` : ""}\n${text(code).replace(/\n$/, "")}\n\`\`\`\n\n`;
		})
		.replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_, table: string) => {
			const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(
				(row) =>
					[...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) =>
						inline(cell[1]).trim(),
					),
			);
			const head = `| ${rows[0].join(" | ")} |\n|${" --- |".repeat(rows[0].length)}`;
			return `\n\n${head}\n${rows
				.slice(1)
				.map((row) => `| ${row.join(" | ")} |`)
				.join("\n")}\n\n`;
		})
		.replace(
			/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/g,
			(_, level, title) => `\n\n${"#".repeat(+level)} ${inline(title)}\n\n`,
		)
		.replace(
			/<li[^>]*>([\s\S]*?)<\/li>/g,
			(_, item) => `\n- ${inline(item).trim()}`,
		)
		.replace(/<\/?(?:ul|ol)[^>]*>/g, "\n\n")
		.replace(
			/<(p|blockquote|aside)[^>]*>([\s\S]*?)<\/\1>/g,
			(_, tag, body) => `\n\n${tag === "p" ? "" : "> "}${inline(body)}\n\n`,
		);
	return `${decode(text(out))
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;

	function inline(s: string): string {
		return s
			.replace(/<code[^>]*>([\s\S]*?)<\/code>/g, "`$1`")
			.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/g, "**$2**")
			.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/g, "_$2_")
			.replace(/<br\s*\/?>/g, "\n")
			.replace(
				/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
				(_, href: string, label) =>
					`[${label}](${href.startsWith("/") ? SITE_URL + href : href})`,
			)
			.replace(/\s*\n\s*/g, (m) => (m.includes("\n\n") ? "\n\n" : " "));
	}
}

function decode(s: string) {
	return s
		.replace(
			/&(lt|gt|quot|#39|nbsp|amp);/g,
			(_, e) =>
				({ lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", amp: "&" })[
					e as "lt"
				],
		)
		.replace(/&#(x?)([0-9a-f]+);/gi, (_, hex, n) =>
			String.fromCodePoint(parseInt(n, hex ? 16 : 10)),
		);
}
