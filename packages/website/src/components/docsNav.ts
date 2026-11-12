export type DocsPage = { href: string; title: string };
/** A sidebar entry: a page, or a group of pages that folds into its title. */
export type DocsEntry = DocsPage | { group: string; pages: DocsPage[] };

export const docsNav: readonly DocsEntry[] = [
	{ href: "/docs", title: "Why Pulsify" },
	{ href: "/docs/getting-started", title: "Getting started" },
	{
		group: "Pulses",
		pages: [
			{ href: "/docs/pulse-methods", title: "Pulse methods" },
			{ href: "/docs/values", title: "Values" },
			{ href: "/docs/modifiers", title: "Value modifiers" },
			{ href: "/docs/migrations", title: "Migrations" },
			{ href: "/docs/materialization", title: "Materialization" },
			{ href: "/docs/editors", title: "Rich text editors" },
		],
	},
	{
		group: "Sync",
		pages: [
			{ href: "/docs/sync", title: "Sync and offline" },
			{ href: "/docs/local-persistence", title: "Local persistence" },
			{ href: "/docs/presence", title: "Presence" },
		],
	},
	{
		group: "Frontend",
		pages: [
			{ href: "/docs/frontend/svelte", title: "Svelte" },
			{ href: "/docs/frontend/solid", title: "Solid" },
			{ href: "/docs/frontend/react", title: "React" },
			{ href: "/docs/frontend/vue", title: "Vue" },
		],
	},
	{
		group: "Self-hosting",
		pages: [
			{ href: "/docs/databases", title: "Databases" },
			{ href: "/docs/auth", title: "Authentication" },
		],
	},
	{
		group: "Cloud",
		pages: [
			{ href: "/docs/cloud", title: "How it works" },
			{ href: "/docs/cloud/authentication", title: "Authentication" },
			{ href: "/docs/cloud/tutorial", title: "Tutorial: a notes app" },
		],
	},
	{ href: "/docs/api", title: "API cheat sheet" },
];

/** Every page in reading order, for the pager. */
export const docsPages: readonly (DocsPage & { group?: string })[] =
	docsNav.flatMap((entry) =>
		"group" in entry
			? entry.pages.map((page) => ({ ...page, group: entry.group }))
			: [entry],
	);
