import { Hero } from "~/components/Hero";
import { Seo } from "~/components/Seo";
import { Sky } from "~/components/Sky";
import {
	Benchmarks,
	Compare,
	Everywhere,
	Frameworks,
	Pillars,
	Showcase,
} from "~/components/Landing";

export default function Home() {
	return (
		<main>
			<Seo
				title="Pulsify: the sync engine for local-first apps"
				description="Pulsify turns plain TypeScript objects into typed, collaborative CRDTs. Self-host sync on your own database, or run it serverless on Pulsify Cloud."
			/>
			<Hero />
			<Sky>
				<Pillars />
				<Showcase />
				<Frameworks />
				<Benchmarks />
				<Compare />
				<Everywhere />
			</Sky>
		</main>
	);
}
