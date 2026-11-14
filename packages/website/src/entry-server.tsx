// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";

export default createHandler(() => (
	<StartServer
		document={({ assets, children, scripts }) => (
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<link rel="icon" href="/favicon.png" type="image/png" />
					<link rel="apple-touch-icon" href="/logo.png" />
					<meta name="theme-color" content="#030d14" />
					{/* Shared by every page; Seo sets the title, description, URL and image. */}
					<meta property="og:type" content="website" />
					<meta property="og:site_name" content="Pulsify" />
					<meta property="og:image:width" content="1200" />
					<meta property="og:image:height" content="630" />
					<meta name="twitter:card" content="summary_large_image" />
					{/* The docs theme: dark unless the toggle stored light; the system preference is not followed. Set before first paint, so it never flashes. */}
					<script
						innerHTML={`try{if(localStorage.getItem("theme")==="light")document.documentElement.dataset.theme="light"}catch{}`}
					/>
					{assets}
				</head>
				<body>
					<div id="app">{children}</div>
					{scripts}
				</body>
			</html>
		)}
	/>
));
