import { createServer } from "node:net";

function isPortFree(port: number, host: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE") resolve(false);
			else if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL")
				resolve(true);
			else reject(error);
		});
		server.listen(port, host, () => server.close(() => resolve(true)));
	});
}

// Check wildcard and loopback binds because macOS can allow them to coexist.
let port = 3000;
ports: for (; port <= 65535; port++) {
	for (const host of ["0.0.0.0", "::", "127.0.0.1", "::1"]) {
		if (!(await isPortFree(port, host))) continue ports;
	}
	break;
}
if (port > 65535) throw new Error("No free port for the Pulsify website.");
console.log(port);
