export const GITHUB_URL = "https://github.com/Gin-Quin/pulsify";
/** The hosted service: dashboard API and project URLs. In dev, `bun run dev:service`. */
export const PULSIFY_API: string =
	import.meta.env.VITE_PULSIFY_API ??
	(import.meta.env.DEV ? "http://localhost:8787" : "https://api.pulsify.cloud");
