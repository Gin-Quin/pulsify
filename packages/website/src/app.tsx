import { MetaProvider, Title } from "@solidjs/meta";
import { Router, useLocation } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Show, Suspense } from "solid-js";
import { Header } from "~/components/Header";
import "./styles/global.css";

export default function App() {
	return (
		<Router
			root={(props) => {
				const location = useLocation();
				return (
					<MetaProvider>
						<Title>Pulsify: the sync engine for local-first apps</Title>
						{/* A demo app fills its window with a header of its own. */}
						<Show when={!location.pathname.startsWith("/demos/")}>
							<Header />
						</Show>
						<Suspense>{props.children}</Suspense>
					</MetaProvider>
				);
			}}
		>
			<FileRoutes />
		</Router>
	);
}
