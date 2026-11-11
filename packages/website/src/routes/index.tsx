import { Hero } from "~/components/Hero";
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
