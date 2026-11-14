import { Hero } from "~/components/Hero";
import { Seo } from "~/components/Seo";
import { Sky } from "~/components/Sky";
import {
	Benchmarks,
	Compare,
	Everywhere,
	Pillars,
	Showcase,
} from "~/components/Landing";

export default function Home() {
	return (
		<main>
			<Seo
				title="Pulsify: distributed sync, beautifully composed"
				description="The typed CRDT framework for TypeScript. Collaborative documents that look like plain objects, migrate themselves and live in your database."
			/>
			<Hero />
			<Sky>
				<Pillars />
				<Showcase />
				<Benchmarks />
				<Compare />
				<Everywhere />
			</Sky>
		</main>
	);
}
