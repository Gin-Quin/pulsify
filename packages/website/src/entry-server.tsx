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
