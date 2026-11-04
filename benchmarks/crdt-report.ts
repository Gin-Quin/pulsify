export type ComparisonReport = {
	schemaVersion: number;
	generatedAt: string;
	commit: string;
	dirty: boolean;
	timingNote?: string;
	environment: {
		runtime: string;
		codec: string;
		jsonJoy: string;
		yjs: string;
		loro: string;
		loroBackend: string;
		platform: string;
		release: string;
		arch: string;
		cpu: string | undefined;
		cores: number;
	};
	parameters: {
		samples: number;
		warmup: number;
		quick: boolean;
		filter: string;
		seed: number;
		fixtureVersion: number;
		defaultYjsFormat: string;
		gcBeforeSamples: boolean;
		ordering: string;
		pulsifyEngine?: string;
		pulsifySchema?: string;
	};
	descriptions: Record<string, string>;
	results: {
		scenario: string;
		participant: string;
		iterations: number;
		sampleMeanUs: { median: number; p95: number; min: number; max: number };
		opsPerSecond: number;
		metrics?: Record<string, number>;
	}[];
};
const number = (value: number) => value.toFixed(2);
export function renderComparison(report: ComparisonReport): string {
	const participants = ["pulsify", "json-joy", "yjs-v2", "loro", "yjs-v1"];
	const rows = (scenario: string) =>
		report.results.filter((result) => result.scenario === scenario);
	const scenarios = [
		...new Set(
			report.results
				.filter((result) => !result.scenario.startsWith("proxy-overhead/"))
				.map((result) => result.scenario),
		),
	];
	const time = (scenario: string, participant: string) =>
		rows(scenario).find((result) => result.participant === participant)
			?.sampleMeanUs.median;
	const formatTime = (value: number | undefined) =>
		value === undefined ? "—" : number(value);
	const main = [
		"| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |",
		"| --- | ---: | ---: | ---: | ---: | ---: |",
		...scenarios.map(
			(scenario) =>
				`| \`${scenario}\` | ${participants.map((participant) => formatTime(time(scenario, participant))).join(" | ")} |`,
		),
	];
	const sizes = [
		"| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |",
		"| --- | ---: | ---: | ---: | ---: | ---: |",
		...scenarios
			.filter((scenario) =>
				rows(scenario).some(
					(result) => result.metrics?.["bytes"] !== undefined,
				),
			)
			.map(
				(scenario) =>
					`| \`${scenario}\` | ${participants
						.map((participant) => {
							const value = rows(scenario).find(
								(result) => result.participant === participant,
							)?.metrics?.["bytes"];
							return value === undefined ? "—" : number(value);
						})
						.join(" | ")} |`,
			),
	];
	const layerScenarios = [
		...new Set(
			report.results
				.filter((result) => result.scenario.startsWith("proxy-overhead/"))
				.map((result) => result.scenario),
		),
	];
	const overhead = [
		"| Scénario | json-joy natif | Pipeline Pulsify sans proxy | Pulsify avec proxy | Écart proxy − pipeline |",
		"| --- | ---: | ---: | ---: | ---: |",
		...layerScenarios.map((scenario) => {
			const native = time(scenario, "native-json-joy");
			const direct = time(scenario, "pulsify-direct");
			const proxy = time(scenario, "pulsify-proxy");
			return `| \`${scenario}\` | ${formatTime(native)} | ${formatTime(direct)} | ${formatTime(proxy)} | ${direct === undefined || proxy === undefined ? "—" : number(proxy - direct)} |`;
		}),
	];
	const all = [
		"| Scénario | Variante | Itérations/échantillon | Médiane µs/op | p95 des moyennes µs/op | Min µs/op | Max µs/op | Octets/op |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
		...report.results.map(
			(result) =>
				`| \`${result.scenario}\` | ${result.participant} | ${result.iterations} | ${number(result.sampleMeanUs.median)} | ${number(result.sampleMeanUs.p95)} | ${number(result.sampleMeanUs.min)} | ${number(result.sampleMeanUs.max)} | ${result.metrics?.["bytes"] === undefined ? "—" : number(result.metrics["bytes"])} |`,
		),
	];
	const layerMutation = "proxy-overhead/mutate-history-0";
	const nativeMutation = time(layerMutation, "native-json-joy");
	const directMutation = time(layerMutation, "pulsify-direct");
	const proxyMutation = time(layerMutation, "pulsify-proxy");
	const interpretation =
		nativeMutation && directMutation && proxyMutation
			? `Sur la mutation scalaire sans historique préparé, l’API publique Pulsify prend ${number(proxyMutation / nativeMutation)} fois le temps de json-joy natif. L'écart proxy − pipeline est de ${number(proxyMutation - directMutation)} µs, soit ${number(((proxyMutation - directMutation) / directMutation) * 100)} % du pipeline sans proxy. Le moteur Pulsify sans proxy prend ${number(directMutation / nativeMutation)} fois le temps natif : ce scénario distingue le coût du chemin public et celui de la mutation interne. Cette décomposition concerne le champ scalaire mis en cache, pas toutes les opérations de listes ou la création des vues.`
			: "";
	const hybrid = report.parameters.pulsifyEngine?.includes("hybrid");
	const baseline = hybrid
		? "baselines/core-hybrid-20261104.json"
		: report.parameters.pulsifyEngine?.includes("grouped")
			? "baselines/core-grouped-20261104.json"
			: report.parameters.pulsifyEngine
				? "baselines/core-native-20261104.json"
				: "baselines/crdt-comparison.json";
	return `# Pulsify, json-joy, Yjs et Loro : comparaison locale

Ce fichier est généré par \`bun run bench:crdt\`. Les données brutes sont dans le JSON indiqué par \`--output\` (par défaut \`benchmarks/results/crdt-comparison.json\`). La référence complète conservée est [${baseline}](${baseline}).

${report.timingNote ? `**Conditions de mesure :** ${report.timingNote}` : ""}

## Environnement et protocole

- ${report.environment.cpu}, ${report.environment.arch}, ${report.environment.platform} ${report.environment.release}, ${report.environment.cores} cœurs.
- ${report.environment.runtime}, codec ${report.environment.codec}, json-joy ${report.environment.jsonJoy}, Yjs ${report.environment.yjs}, loro-crdt ${report.environment.loro} (${report.environment.loroBackend}).
- ${report.parameters.warmup} échantillons d'échauffement puis ${report.parameters.samples} mesurés ; ${report.results.length} résultats. Mode court : ${report.parameters.quick}. Filtre : \`${report.parameters.filter || "aucun"}\`.
- Ordre des participants mélangé à chaque bloc avec une graine fixe (${report.parameters.seed}). GC forcé avant et après la préparation de chaque échantillon, hors chronométrage : les allocations temporaires de l'historique de préparation ne sont pas imputées à la mutation mesurée. Chaque échantillon utilise un état neuf.
- Les durées sont des **médianes de moyennes par échantillon**, en µs/op. Le p95 final porte lui aussi sur ces moyennes et ne représente pas la latence p95 de chaque événement individuel.
- Mesure UTC : ${report.generatedAt}. Commit de base : \`${report.commit}\`. Copie de travail modifiée : ${report.dirty}.
${report.parameters.pulsifyEngine ? `- Moteur Pulsify : ${report.parameters.pulsifyEngine}. Schéma fourni explicitement : ${report.parameters.pulsifySchema}. Sa compilation et la définition sont préparées hors chronométrage ; les données et conteneurs éditables restent ceux de la suite initiale.` : ""}
- Les schémas applicatifs compilent leurs codecs, copies et contrôles de valeurs. Pulsify exécute les contrôles des champs affectés avant leur commit ou application. Le décodage de l'enveloppe utilise codec directement, sans second parcours récursif de son schéma. Les limites de trame, références causales et règles de cohérence sont conservées.

## Temps comparés

Les mêmes champs et valeurs sont utilisés : métadonnées de document, chaîne atomique, map imbriquée modifiable et liste de maps à deux champs. Les conteneurs imbriqués sont des CRDT dans les quatre implémentations, pas des objets JSON opaques. Les références du champ imbriqué sont mises en cache pour les lectures et mutations scalaires.

${main.join("\n")}

## Taille des représentations transférées

Octets moyens par opération mesurée. Pour \`offline-merge\`, la valeur est la somme des deux deltas ; pour le conflit à 16 pairs, la somme des deltas importés par un seul récepteur. Ces octets sont des charges utiles, hors TCP/WebSocket/TLS.

${sizes.join("\n")}

Les représentations ne retiennent pas toutes le même historique : ${hybrid ? "Pulsify conserve le journal exact au producteur et peut transmettre un état scalaire condensé avec des vecteurs d’état et d’historique distincts" : "Pulsify transmet son journal de segments dans des messages validés avec identifiant et vecteurs"} ; json-joy natif utilise ses snapshots structurels et deltas ; Yjs utilise son état avec le GC activé par défaut ; Loro utilise un snapshot avec historique, puis des updates. Aucun snapshot superficiel Loro ni stockage supplémentaire pour restaurer les anciennes versions Yjs n'est ajouté.

## Isolation du coût des proxies

Le pipeline « sans proxy » utilise la même instance Pulsify et le même chemin de commit et de journal que le proxy public, mais appelle directement \`CoreModel.set\` pour le champ scalaire. Aucun encodage n'est effectué dans ces écritures locales. Un test exporte ensuite les deux historiques et vérifie **exactement les mêmes octets**. La différence avec json-joy natif comprend les autres services de Pulsify et son chemin de mutation, pas seulement les proxies.

${overhead.join("\n")}

Les écarts sont des différences de médianes observées, pas un profil instruction par instruction. Un petit écart ou un écart négatif peut être du bruit ou une différence d'optimisation JIT. La création et l'encodage du journal ne doivent donc pas être attribués intégralement aux proxies.

L'écart public − direct inclut aussi les contrôles et conversions du setter public. Il ne mesure pas seulement les instructions des traps JavaScript.

${interpretation}

Pulsify utilise son propre moteur : registres LWW pour les champs et RGA pour les listes. Aucun moteur json-joy ou Yjs ne se trouve dans son chemin d’exécution. L’import prévalide les références et modifications puis applique chaque patch, sans cloner le document entier. Les métadonnées de racine sont vérifiées lors de leur création ou modification. Les migrations ne lisent et ne copient la vue que si une migration est réellement nécessaire ([PulseRuntime.ts](../packages/pulse/source/pulses/PulseRuntime.ts)). Sans matérialiseur personnalisé, le snapshot utilise une copie spécialisée du schéma lorsque la forme de la vue le permet et conserve une copie générale sinon. Un matérialiseur conserve son parcours public. ${hybrid ? "Le journal du producteur conserve chaque transaction ; le transport v3 négocié peut condenser les valeurs scalaires écrasées. Le récepteur distingue son vecteur d’état de ses opérations physiquement retenues et peut récupérer celles-ci auprès d’une source complète. Le stockage et les uploads restent exacts." : "Le journal conserve chaque transaction, tandis que les formats structurels peuvent condenser les valeurs écrasées. Le transport groupé, lorsqu’il est négocié, partage les en-têtes scalaires sans supprimer les opérations."}

## Ce que mesure chaque scénario

${Object.entries(report.descriptions)
	.map(([name, description]) => `- \`${name}\` : ${description}`)
	.join("\n")}

## Limites de la comparaison

- \`create\` et \`mutate\` mesurent le travail local sans export binaire, y compris pour Pulsify qui conserve ses patches natifs. \`create+encode\`, \`edit+encode\` et \`delta-roundtrip\` ajoutent explicitement la production de données binaires pour tous.
- \`export-first\` mesure le premier export d'un document préparé ; \`export-repeat\` effectue un export préparatoire hors chrono puis mesure un export sans modification. Les bibliothèques sont déjà échauffées, les états sont neufs à chaque échantillon et les paquets sont vérifiés par import hors chrono. Chaque moteur utilise ses propres caches.
- \`delta-roundtrip\` est un échange synchrone entre deux moteurs en mémoire ; le protocole réseau, l'acquittement, l'authentification et une base durable ne sont pas inclus. Les anciens benchmarks de connecteurs Pulsify mesurent un autre niveau.
- L'adaptateur json-joy exporte un delta structurel via \`model.delta(vecteur)\` ; ${hybrid ? "Pulsify utilise son échange public v3, avec état condensé pour les longues séries scalaires et opérations exactes sinon." : "Pulsify exporte les opérations déjà conservées dans son journal."} Un bon résultat de Pulsify sur cet échange ne signifie donc pas que ses proxies exécutent les opérations natives plus vite. Le tableau des trois couches isole les écritures locales.
- \`initial-load+materialize\` inclut la création du récepteur et une vue JSON détachée. L'export initial, la validation des résultats et la destruction des répliques sont hors chronométrage.
- Loro est la version WASM publiée pour Node, chargée une fois avant les mesures. Le coût de démarrage du processus, de chargement du module et de compilation WASM n'est pas inclus. Ce n'est pas un benchmark Rust natif.
- La mémoire JS seule n'est pas comparée à la mémoire WASM : un classement fondé uniquement sur \`heapUsed\` serait trompeur. Les anciens chiffres mémoire de Pulsify restent dans [README.md](README.md).
- Cette suite ne compare pas le texte caractère par caractère, les déplacements natifs de \`MovableList\`, les arbres ou le voyage dans le temps comme tâches équivalentes.
- Le conflit multi-pairs est réduit à 16 participants. La limite actuelle de vecteur de Pulsify est de 1 024 acteurs ; le test amont avec \`N = 6000\` et \`20 × floor(√N)\` dépasserait cette limite. Les scores de ce scénario ne prétendent pas reproduire cette échelle amont.

## Sources GitHub consultées et adaptations

La méthode et les adaptateurs ont été contrôlés par un [agent indépendant](INDEPENDENT-AUDIT.md). Les différences de fonctionnalités ci-dessus sont conservées explicitement ; ces tableaux comparent des tâches complètes et ne constituent pas un classement universel des moteurs ou codecs.

Les scripts ont été récupérés pour consultation dans \`/tmp/pulsify-benchmark-references\` ; ils ne sont pas exécutés tels quels ni intégrés à ce dépôt. Les scénarios ici sont des adaptations avec les versions installées, pas les résultats historiques publiés par leurs auteurs.

- [Yjs : README et lien vers crdt-benchmarks](https://github.com/yjs/yjs#readme).
- [crdt-benchmarks, B1 (auteur de Yjs)](https://github.com/dmonad/crdt-benchmarks/blob/796f70250c8c003dfb3a50369d0b2733a760e54d/js-lib/b1.js) : éditions individuelles, mises à jour binaires, export et import. L'ajout en liste reprend la famille B1.8 avec des objets éditables au lieu de nombres.
- [B3.1, conflits de maps](https://github.com/dmonad/crdt-benchmarks/blob/796f70250c8c003dfb3a50369d0b2733a760e54d/js-lib/b3.js) : adaptation à 16 pairs partageant notre document initial ; ce n'est pas la taille amont \`20√N\`.
- [Adaptateur Yjs amont](https://github.com/dmonad/crdt-benchmarks/blob/796f70250c8c003dfb3a50369d0b2733a760e54d/benchmarks/yjs/factory.js) : format V2 utilisé pour la colonne principale ; V1 est aussi mesuré pour les scénarios de sérialisation.
- [Adaptateur Loro amont](https://github.com/dmonad/crdt-benchmarks/blob/796f70250c8c003dfb3a50369d0b2733a760e54d/benchmarks/loro/factory.js) : snapshots pour le chargement initial, deltas pour les échanges, API adaptée à Loro ${report.environment.loro}.
- [Loro : complexité et recherches répétées](https://github.com/loro-dev/loro/blob/ea1d383e2c106c0233ac6986a998f6af688cf613/loro-js/benchmarks/complexity.mjs), [snapshot/import/toJSON et listes](https://github.com/loro-dev/loro/blob/ea1d383e2c106c0233ac6986a998f6af688cf613/loro-js/benchmarks/movable-list.mjs) et [mesures mémoire séparées JS/external/RSS](https://github.com/loro-dev/loro/blob/ea1d383e2c106c0233ac6986a998f6af688cf613/loro-js/benchmarks/snapshot-memory.mjs) : séparation lecture, mutation, import et matérialisation. Les opérations spécifiques à Loro ne sont pas transposées artificiellement.

## Résultats détaillés

${all.join("\n")}
`;
}
