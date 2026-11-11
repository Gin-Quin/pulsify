export const docsNav: readonly {
	href: string;
	title: string;
	section?: string;
}[] = [
	{ href: "/docs", title: "Why Pulsify" },
	{ href: "/docs/getting-started", title: "Getting started" },
	{ href: "/docs/values", title: "Values" },
	{ href: "/docs/migrations", title: "Migrations" },
	{ href: "/docs/materialization", title: "Materialization" },
	{ href: "/docs/sync", title: "Sync and offline" },
	{ href: "/docs/local-persistence", title: "Local persistence" },
	{ href: "/docs/databases", title: "Self-host: databases" },
	{ href: "/docs/auth", title: "Self-host: authentication" },
	{ href: "/docs/cloud", title: "How it works", section: "Cloud" },
	{
		href: "/docs/cloud/authentication",
		title: "Authentication",
		section: "Cloud",
	},
	{
		href: "/docs/cloud/tutorial",
		title: "Tutorial: a notes app",
		section: "Cloud",
	},
	{
		href: "/docs/cloud/cloudflare",
		title: "Cloudflare backend",
		section: "Cloud",
	},
	{
		href: "/docs/cloud/unikraft-cloud",
		title: "Unikraft Cloud backend",
		section: "Cloud",
	},
	{ href: "/docs/frontend/svelte", title: "Svelte", section: "Frontend" },
	{ href: "/docs/frontend/solid", title: "Solid", section: "Frontend" },
	{ href: "/docs/frontend/react", title: "React", section: "Frontend" },
	{ href: "/docs/frontend/vue", title: "Vue", section: "Frontend" },
	{ href: "/docs/editors", title: "Rich text editors" },
	{ href: "/docs/api", title: "API cheat sheet" },
];
