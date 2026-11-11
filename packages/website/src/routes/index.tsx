import { Hero } from "~/components/Hero";
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
			<Pillars />
			<Showcase />
			<Benchmarks />
			<Compare />
			<Everywhere />
		</main>
	);
}
