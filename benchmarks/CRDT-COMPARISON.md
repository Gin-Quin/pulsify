# Pulsify, json-joy, Yjs et Loro : comparaison locale

Ce fichier est généré par `bun run bench:crdt`. Les données brutes sont dans le JSON indiqué par `--output` (par défaut `benchmarks/results/crdt-comparison.json`). La référence complète conservée est [baselines/core-hybrid-20261104.json](baselines/core-hybrid-20261104.json).



## Environnement et protocole

- Apple M4, arm64, darwin 25.3.0, 10 cœurs.
- bun-1.4.4, codec 2.1.0, json-joy 18.28.0, Yjs 13.6.33, loro-crdt 1.17.1 (wasm-nodejs).
- 5 échantillons d'échauffement puis 25 mesurés ; 95 résultats. Mode court : false. Filtre : `aucun`.
- Ordre des participants mélangé à chaque bloc avec une graine fixe (5370206). GC forcé avant et après la préparation de chaque échantillon, hors chronométrage : les allocations temporaires de l'historique de préparation ne sont pas imputées à la mutation mesurée. Chaque échantillon utilise un état neuf.
- Les durées sont des **médianes de moyennes par échantillon**, en µs/op. Le p95 final porte lui aussi sur ces moyennes et ne représente pas la latence p95 de chaque événement individuel.
- Mesure UTC : 2026-11-04T16:47:05.696Z. Commit de base : `b6d020d3c0fa616c6be9a5f7ddd4c4c600f4fb08`. Copie de travail modifiée : false.
- Moteur Pulsify : native-core-v3-hybrid. Schéma fourni explicitement : codec object: title string, nested count float64, items editable array of { value float64, label string }. Sa compilation et la définition sont préparées hors chronométrage ; les données et conteneurs éditables restent ceux de la suite initiale.
- Les schémas applicatifs compilent leurs codecs, copies et contrôles de valeurs. Pulsify exécute les contrôles des champs affectés avant leur commit ou application. Le décodage de l'enveloppe utilise codec directement, sans second parcours récursif de son schéma. Les limites de trame, références causales et règles de cohérence sont conservées.

## Temps comparés

Les mêmes champs et valeurs sont utilisés : métadonnées de document, chaîne atomique, map imbriquée modifiable et liste de maps à deux champs. Les conteneurs imbriqués sont des CRDT dans les quatre implémentations, pas des objets JSON opaques. Les références du champ imbriqué sont mises en cache pour les lectures et mutations scalaires.

| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create/10` | 10.65 | 12.32 | 15.80 | 58.78 | — |
| `create+encode/10` | 14.65 | 13.25 | 20.07 | 104.75 | 16.20 |
| `create/1000` | 275.37 | 497.56 | 340.04 | 3193.60 | — |
| `create+encode/1000` | 324.13 | 743.35 | 497.13 | 4759.10 | 559.71 |
| `export-first/1000` | 69.96 | 277.42 | 186.17 | 1680.12 | 244.12 |
| `export-repeat/1000` | 25.96 | 263.04 | 177.87 | 81.17 | 239.17 |
| `read-count/10` | 0.02 | 0.01 | 0.01 | 0.13 | — |
| `mutate/history-0` | 0.26 | 0.39 | 1.15 | 1.31 | — |
| `mutate/history-1000` | 0.18 | 0.28 | 0.91 | 1.28 | — |
| `mutate/history-5000` | 0.16 | 0.28 | 0.91 | 1.24 | — |
| `list-append/10` | 1.00 | 0.97 | 1.49 | 4.26 | — |
| `edit+encode/10` | 2.23 | 2.71 | 4.88 | 8.31 | 2.28 |
| `delta-roundtrip/10` | 4.26 | 4.47 | 7.60 | 15.63 | 3.99 |
| `delta-roundtrip/1000` | 14.40 | 159.33 | 28.96 | 49.09 | 22.99 |
| `initial-load+materialize/10` | 14.26 | 14.90 | 15.91 | 46.86 | 15.99 |
| `initial-load+materialize/1000` | 372.60 | 679.56 | 556.50 | 1634.58 | 654.00 |
| `offline-merge/100-per-peer` | 143.33 | 85.83 | 81.79 | 240.37 | 64.13 |
| `upstream-map-conflict/16-peers` | 61.54 | 60.17 | 95.46 | 391.46 | 78.08 |

## Taille des représentations transférées

Octets moyens par opération mesurée. Pour `offline-merge`, la valeur est la somme des deux deltas ; pour le conflit à 16 pairs, la somme des deltas importés par un seul récepteur. Ces octets sont des charges utiles, hors TCP/WebSocket/TLS.

| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create+encode/10` | 284.00 | 439.00 | 449.00 | 1030.00 | 593.00 |
| `create+encode/1000` | 17027.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `export-first/1000` | 17027.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `export-repeat/1000` | 17027.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `edit+encode/10` | 104.00 | 58.79 | 33.44 | 86.57 | 23.54 |
| `delta-roundtrip/10` | 104.00 | 63.88 | 32.94 | 86.00 | 22.96 |
| `delta-roundtrip/1000` | 104.00 | 70.60 | 34.20 | 88.00 | 25.20 |
| `initial-load+materialize/10` | 284.00 | 439.00 | 449.00 | 1030.00 | 593.00 |
| `initial-load+materialize/1000` | 17027.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `offline-merge/100-per-peer` | 176.00 | 139.00 | 97.00 | 1624.00 | 75.00 |
| `upstream-map-conflict/16-peers` | 1728.00 | 1024.00 | 512.00 | 1536.00 | 336.00 |

Les représentations ne retiennent pas toutes le même historique : Pulsify conserve le journal exact au producteur et peut transmettre un état scalaire condensé avec des vecteurs d’état et d’historique distincts ; json-joy natif utilise ses snapshots structurels et deltas ; Yjs utilise son état avec le GC activé par défaut ; Loro utilise un snapshot avec historique, puis des updates. Aucun snapshot superficiel Loro ni stockage supplémentaire pour restaurer les anciennes versions Yjs n'est ajouté.

## Isolation du coût des proxies

Le pipeline « sans proxy » utilise la même instance Pulsify et le même chemin de commit et de journal que le proxy public, mais appelle directement `CoreModel.set` pour le champ scalaire. Aucun encodage n'est effectué dans ces écritures locales. Un test exporte ensuite les deux historiques et vérifie **exactement les mêmes octets**. La différence avec json-joy natif comprend les autres services de Pulsify et son chemin de mutation, pas seulement les proxies.

| Scénario | json-joy natif | Pipeline Pulsify sans proxy | Pulsify avec proxy | Écart proxy − pipeline |
| --- | ---: | ---: | ---: | ---: |
| `proxy-overhead/read-count` | 0.01 | 0.01 | 0.02 | 0.01 |
| `proxy-overhead/mutate-history-0` | 0.30 | 0.24 | 0.26 | 0.02 |
| `proxy-overhead/mutate-history-1000` | 0.29 | 0.18 | 0.19 | 0.01 |
| `proxy-overhead/mutate-history-5000` | 0.28 | 0.17 | 0.17 | 0.00 |

Les écarts sont des différences de médianes observées, pas un profil instruction par instruction. Un petit écart ou un écart négatif peut être du bruit ou une différence d'optimisation JIT. La création et l'encodage du journal ne doivent donc pas être attribués intégralement aux proxies.

L'écart public − direct inclut aussi les contrôles et conversions du setter public. Il ne mesure pas seulement les instructions des traps JavaScript.

Sur la mutation scalaire sans historique préparé, l’API publique Pulsify prend 0.87 fois le temps de json-joy natif. L'écart proxy − pipeline est de 0.02 µs, soit 7.33 % du pipeline sans proxy. Le moteur Pulsify sans proxy prend 0.81 fois le temps natif : ce scénario distingue le coût du chemin public et celui de la mutation interne. Cette décomposition concerne le champ scalaire mis en cache, pas toutes les opérations de listes ou la création des vues.

Pulsify utilise son propre moteur : registres LWW pour les champs et RGA pour les listes. Aucun moteur json-joy ou Yjs ne se trouve dans son chemin d’exécution. L’import prévalide les références et modifications puis applique chaque patch, sans cloner le document entier. Les métadonnées de racine sont vérifiées lors de leur création ou modification. Les migrations ne lisent et ne copient la vue que si une migration est réellement nécessaire ([PulseRuntime.ts](../packages/pulse/source/pulses/PulseRuntime.ts)). Sans matérialiseur personnalisé, le snapshot utilise une copie spécialisée du schéma lorsque la forme de la vue le permet et conserve une copie générale sinon. Un matérialiseur conserve son parcours public. Le journal du producteur conserve chaque transaction ; le transport v3 négocié peut condenser les valeurs scalaires écrasées. Le récepteur distingue son vecteur d’état de ses opérations physiquement retenues et peut récupérer celles-ci auprès d’une source complète. Le stockage et les uploads restent exacts.

## Ce que mesure chaque scénario

- `create/10` : Create an editable 10-item graph; cleanup is outside timing.
- `create+encode/10` : Create an editable 10-item graph and export a transferable initial state; cleanup is outside timing.
- `create/1000` : Create an editable 1000-item graph; cleanup is outside timing.
- `create+encode/1000` : Create an editable 1000-item graph and export a transferable initial state; cleanup is outside timing.
- `export-first/1000` : Export a prepared 1000-item document for the first time; construction, import verification and cleanup are outside timing.
- `export-repeat/1000` : Export a prepared 1000-item document after one untimed export, without any edit; construction, import verification and cleanup are outside timing.
- `read-count/10` : Read a cached editable nested count; initial container lookup is outside timing.
- `mutate/history-0` : One committed count update through each library's default local API; Pulsify retains its native patch without encoding. Encoding is measured separately in edit+encode.
- `mutate/history-1000` : One committed count update through each library's default local API; Pulsify retains its native patch without encoding. Encoding is measured separately in edit+encode.
- `mutate/history-5000` : One committed count update through each library's default local API; Pulsify retains its native patch without encoding. Encoding is measured separately in edit+encode.
- `list-append/10` : Append a new editable two-field object to the list and commit once per append (adapted from B1.8; objects replace upstream's numbers).
- `edit+encode/10` : Capture a version, commit one count edit, encode its incremental update; verify all encoded packets on a peer outside timing.
- `delta-roundtrip/10` : Version-vector capture + edit + delta encoding + peer import + peer count read; synchronous CPU-only, without transport or acknowledgement.
- `delta-roundtrip/1000` : Version-vector capture + edit + delta encoding + peer import + peer count read; synchronous CPU-only, without transport or acknowledgement.
- `initial-load+materialize/10` : Construct an empty replica, import an initial state and materialize a detached JSON view. Export is prepared outside timing; cleanup is outside timing.
- `initial-load+materialize/1000` : Construct an empty replica, import an initial state and materialize a detached JSON view. Export is prepared outside timing; cleanup is outside timing.
- `offline-merge/100-per-peer` : Two initialized peers make 100 committed offline edits each; time vector capture, two-way delta encode/import and materialization. Edits are outside timing.
- `upstream-map-conflict/16-peers` : Adapted B3.1: 16 peers sharing a baseline concurrently update one map key; time importing all deltas and materializing one peer. Setup/encoding and a reference merge are outside timing.
- `proxy-overhead/read-count` : Same cached nested field, native API versus the Pulsify pipeline bypassing proxies versus the public proxy.
- `proxy-overhead/mutate-history-0` : Native json-joy versus identical Pulsify commit/native-journal pipeline with and without proxy traps; no encoding during local writes, encoded rows are verified identical after export.
- `proxy-overhead/mutate-history-1000` : Native json-joy versus identical Pulsify commit/native-journal pipeline with and without proxy traps; no encoding during local writes, encoded rows are verified identical after export.
- `proxy-overhead/mutate-history-5000` : Native json-joy versus identical Pulsify commit/native-journal pipeline with and without proxy traps; no encoding during local writes, encoded rows are verified identical after export.

## Limites de la comparaison

- `create` et `mutate` mesurent le travail local sans export binaire, y compris pour Pulsify qui conserve ses patches natifs. `create+encode`, `edit+encode` et `delta-roundtrip` ajoutent explicitement la production de données binaires pour tous.
- `export-first` mesure le premier export d'un document préparé ; `export-repeat` effectue un export préparatoire hors chrono puis mesure un export sans modification. Les bibliothèques sont déjà échauffées, les états sont neufs à chaque échantillon et les paquets sont vérifiés par import hors chrono. Chaque moteur utilise ses propres caches.
- `delta-roundtrip` est un échange synchrone entre deux moteurs en mémoire ; le protocole réseau, l'acquittement, l'authentification et une base durable ne sont pas inclus. Les anciens benchmarks de connecteurs Pulsify mesurent un autre niveau.
- L'adaptateur json-joy exporte un delta structurel via `model.delta(vecteur)` ; Pulsify utilise son échange public v3, avec état condensé pour les longues séries scalaires et opérations exactes sinon. Un bon résultat de Pulsify sur cet échange ne signifie donc pas que ses proxies exécutent les opérations natives plus vite. Le tableau des trois couches isole les écritures locales.
- `initial-load+materialize` inclut la création du récepteur et une vue JSON détachée. L'export initial, la validation des résultats et la destruction des répliques sont hors chronométrage.
- Loro est la version WASM publiée pour Node, chargée une fois avant les mesures. Le coût de démarrage du processus, de chargement du module et de compilation WASM n'est pas inclus. Ce n'est pas un benchmark Rust natif.
- La mémoire JS seule n'est pas comparée à la mémoire WASM : un classement fondé uniquement sur `heapUsed` serait trompeur. Les anciens chiffres mémoire de Pulsify restent dans [README.md](README.md).
- Cette suite ne compare pas le texte caractère par caractère, les déplacements natifs de `MovableList`, les arbres ou le voyage dans le temps comme tâches équivalentes.
- Le conflit multi-pairs est réduit à 16 participants. La limite actuelle de vecteur de Pulsify est de 1 024 acteurs ; le test amont avec `N = 6000` et `20 × floor(√N)` dépasserait cette limite. Les scores de ce scénario ne prétendent pas reproduire cette échelle amont.

## Sources GitHub consultées et adaptations

La méthode et les adaptateurs ont été contrôlés par un [agent indépendant](INDEPENDENT-AUDIT.md). Les différences de fonctionnalités ci-dessus sont conservées explicitement ; ces tableaux comparent des tâches complètes et ne constituent pas un classement universel des moteurs ou codecs.

Les scripts ont été récupérés pour consultation dans `/tmp/pulsify-benchmark-references` ; ils ne sont pas exécutés tels quels ni intégrés à ce dépôt. Les scénarios ici sont des adaptations avec les versions installées, pas les résultats historiques publiés par leurs auteurs.

- [Yjs : README et lien vers crdt-benchmarks](https://github.com/yjs/yjs#readme).
- [crdt-benchmarks, B1 (auteur de Yjs)](https://github.com/dmonad/crdt-benchmarks/blob/796f70250c8c003dfb3a50369d0b2733a760e54d/js-lib/b1.js) : éditions individuelles, mises à jour binaires, export et import. L'ajout en liste reprend la famille B1.8 avec des objets éditables au lieu de nombres.
- [B3.1, conflits de maps](https://github.com/dmonad/crdt-benchmarks/blob/796f70250c8c003dfb3a50369d0b2733a760e54d/js-lib/b3.js) : adaptation à 16 pairs partageant notre document initial ; ce n'est pas la taille amont `20√N`.
- [Adaptateur Yjs amont](https://github.com/dmonad/crdt-benchmarks/blob/796f70250c8c003dfb3a50369d0b2733a760e54d/benchmarks/yjs/factory.js) : format V2 utilisé pour la colonne principale ; V1 est aussi mesuré pour les scénarios de sérialisation.
- [Adaptateur Loro amont](https://github.com/dmonad/crdt-benchmarks/blob/796f70250c8c003dfb3a50369d0b2733a760e54d/benchmarks/loro/factory.js) : snapshots pour le chargement initial, deltas pour les échanges, API adaptée à Loro 1.17.1.
- [Loro : complexité et recherches répétées](https://github.com/loro-dev/loro/blob/ea1d383e2c106c0233ac6986a998f6af688cf613/loro-js/benchmarks/complexity.mjs), [snapshot/import/toJSON et listes](https://github.com/loro-dev/loro/blob/ea1d383e2c106c0233ac6986a998f6af688cf613/loro-js/benchmarks/movable-list.mjs) et [mesures mémoire séparées JS/external/RSS](https://github.com/loro-dev/loro/blob/ea1d383e2c106c0233ac6986a998f6af688cf613/loro-js/benchmarks/snapshot-memory.mjs) : séparation lecture, mutation, import et matérialisation. Les opérations spécifiques à Loro ne sont pas transposées artificiellement.

## Résultats détaillés

| Scénario | Variante | Itérations/échantillon | Médiane µs/op | p95 des moyennes µs/op | Min µs/op | Max µs/op | Octets/op |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `create/10` | pulsify | 20 | 10.65 | 19.53 | 8.40 | 19.81 | — |
| `create/10` | json-joy | 20 | 12.32 | 30.75 | 9.25 | 61.88 | — |
| `create/10` | yjs-v2 | 20 | 15.80 | 23.52 | 12.53 | 32.82 | — |
| `create/10` | loro | 20 | 58.78 | 125.94 | 49.30 | 159.54 | — |
| `create+encode/10` | pulsify | 20 | 14.65 | 19.59 | 11.03 | 34.44 | 284.00 |
| `create+encode/10` | json-joy | 20 | 13.25 | 16.99 | 10.62 | 19.81 | 439.00 |
| `create+encode/10` | yjs-v2 | 20 | 20.07 | 27.16 | 15.31 | 32.19 | 449.00 |
| `create+encode/10` | loro | 20 | 104.75 | 147.80 | 90.16 | 149.34 | 1030.00 |
| `create+encode/10` | yjs-v1 | 20 | 16.20 | 21.99 | 14.22 | 22.30 | 593.00 |
| `create/1000` | pulsify | 2 | 275.37 | 328.77 | 244.52 | 339.69 | — |
| `create/1000` | json-joy | 2 | 497.56 | 601.96 | 457.44 | 615.77 | — |
| `create/1000` | yjs-v2 | 2 | 340.04 | 422.81 | 313.42 | 484.98 | — |
| `create/1000` | loro | 2 | 3193.60 | 3745.17 | 3024.00 | 3753.42 | — |
| `create+encode/1000` | pulsify | 2 | 324.13 | 386.96 | 289.35 | 398.71 | 17027.00 |
| `create+encode/1000` | json-joy | 2 | 743.35 | 795.31 | 713.44 | 822.88 | 36766.00 |
| `create+encode/1000` | yjs-v2 | 2 | 497.13 | 573.33 | 466.31 | 614.35 | 30012.00 |
| `create+encode/1000` | loro | 2 | 4759.10 | 5167.48 | 4586.04 | 5178.23 | 49733.00 |
| `create+encode/1000` | yjs-v1 | 2 | 559.71 | 630.96 | 528.23 | 650.52 | 47879.00 |
| `export-first/1000` | pulsify | 1 | 69.96 | 84.75 | 62.25 | 99.96 | 17027.00 |
| `export-first/1000` | json-joy | 1 | 277.42 | 290.12 | 260.67 | 318.33 | 36766.00 |
| `export-first/1000` | yjs-v2 | 1 | 186.17 | 207.63 | 164.71 | 223.87 | 30012.00 |
| `export-first/1000` | loro | 1 | 1680.12 | 1720.17 | 1638.83 | 1724.29 | 49733.00 |
| `export-first/1000` | yjs-v1 | 1 | 244.12 | 290.29 | 225.75 | 298.37 | 47879.00 |
| `export-repeat/1000` | pulsify | 1 | 25.96 | 43.46 | 20.25 | 45.08 | 17027.00 |
| `export-repeat/1000` | json-joy | 1 | 263.04 | 300.42 | 233.08 | 307.25 | 36766.00 |
| `export-repeat/1000` | yjs-v2 | 1 | 177.87 | 244.17 | 151.33 | 322.25 | 30012.00 |
| `export-repeat/1000` | loro | 1 | 81.17 | 93.79 | 62.92 | 103.50 | 49733.00 |
| `export-repeat/1000` | yjs-v1 | 1 | 239.17 | 316.21 | 208.29 | 353.25 | 47879.00 |
| `read-count/10` | pulsify | 10000 | 0.02 | 0.02 | 0.02 | 0.05 | — |
| `read-count/10` | json-joy | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `read-count/10` | yjs-v2 | 10000 | 0.01 | 0.01 | 0.01 | 0.02 | — |
| `read-count/10` | loro | 10000 | 0.13 | 0.14 | 0.12 | 0.14 | — |
| `mutate/history-0` | pulsify | 200 | 0.26 | 0.31 | 0.23 | 0.35 | — |
| `mutate/history-0` | json-joy | 200 | 0.39 | 0.65 | 0.35 | 0.99 | — |
| `mutate/history-0` | yjs-v2 | 200 | 1.15 | 1.36 | 1.01 | 1.48 | — |
| `mutate/history-0` | loro | 200 | 1.31 | 1.51 | 1.28 | 1.59 | — |
| `mutate/history-1000` | pulsify | 200 | 0.18 | 0.25 | 0.13 | 0.26 | — |
| `mutate/history-1000` | json-joy | 200 | 0.28 | 0.36 | 0.25 | 0.36 | — |
| `mutate/history-1000` | yjs-v2 | 200 | 0.91 | 1.00 | 0.83 | 1.35 | — |
| `mutate/history-1000` | loro | 200 | 1.28 | 1.36 | 1.20 | 1.47 | — |
| `mutate/history-5000` | pulsify | 200 | 0.16 | 0.21 | 0.13 | 0.21 | — |
| `mutate/history-5000` | json-joy | 200 | 0.28 | 0.34 | 0.24 | 0.36 | — |
| `mutate/history-5000` | yjs-v2 | 200 | 0.91 | 1.02 | 0.80 | 1.04 | — |
| `mutate/history-5000` | loro | 200 | 1.24 | 1.37 | 1.19 | 1.41 | — |
| `list-append/10` | pulsify | 100 | 1.00 | 1.82 | 0.89 | 1.83 | — |
| `list-append/10` | json-joy | 100 | 0.97 | 1.36 | 0.85 | 1.55 | — |
| `list-append/10` | yjs-v2 | 100 | 1.49 | 1.80 | 1.34 | 1.91 | — |
| `list-append/10` | loro | 100 | 4.26 | 4.48 | 4.15 | 4.53 | — |
| `edit+encode/10` | pulsify | 100 | 2.23 | 3.15 | 1.90 | 3.65 | 104.00 |
| `edit+encode/10` | json-joy | 100 | 2.71 | 3.60 | 2.46 | 3.68 | 58.79 |
| `edit+encode/10` | yjs-v2 | 100 | 4.88 | 5.64 | 4.65 | 5.77 | 33.44 |
| `edit+encode/10` | loro | 100 | 8.31 | 12.12 | 7.27 | 12.53 | 86.57 |
| `edit+encode/10` | yjs-v1 | 100 | 2.28 | 2.51 | 2.08 | 2.57 | 23.54 |
| `delta-roundtrip/10` | pulsify | 50 | 4.26 | 5.15 | 3.77 | 6.58 | 104.00 |
| `delta-roundtrip/10` | json-joy | 50 | 4.47 | 5.96 | 3.85 | 6.49 | 63.88 |
| `delta-roundtrip/10` | yjs-v2 | 50 | 7.60 | 8.58 | 7.15 | 10.26 | 32.94 |
| `delta-roundtrip/10` | loro | 50 | 15.63 | 18.66 | 14.78 | 19.84 | 86.00 |
| `delta-roundtrip/10` | yjs-v1 | 50 | 3.99 | 4.75 | 3.54 | 5.23 | 22.96 |
| `delta-roundtrip/1000` | pulsify | 5 | 14.40 | 17.89 | 12.08 | 19.21 | 104.00 |
| `delta-roundtrip/1000` | json-joy | 5 | 159.33 | 175.03 | 146.33 | 176.60 | 70.60 |
| `delta-roundtrip/1000` | yjs-v2 | 5 | 28.96 | 33.00 | 25.66 | 34.07 | 34.20 |
| `delta-roundtrip/1000` | loro | 5 | 49.09 | 61.52 | 43.98 | 66.41 | 88.00 |
| `delta-roundtrip/1000` | yjs-v1 | 5 | 22.99 | 33.28 | 20.42 | 34.74 | 25.20 |
| `initial-load+materialize/10` | pulsify | 10 | 14.26 | 16.41 | 12.46 | 17.16 | 284.00 |
| `initial-load+materialize/10` | json-joy | 10 | 14.90 | 16.55 | 13.36 | 17.39 | 439.00 |
| `initial-load+materialize/10` | yjs-v2 | 10 | 15.91 | 17.93 | 14.42 | 18.00 | 449.00 |
| `initial-load+materialize/10` | loro | 10 | 46.86 | 50.41 | 43.55 | 51.54 | 1030.00 |
| `initial-load+materialize/10` | yjs-v1 | 10 | 15.99 | 17.95 | 14.66 | 20.64 | 593.00 |
| `initial-load+materialize/1000` | pulsify | 2 | 372.60 | 427.10 | 357.56 | 452.75 | 17027.00 |
| `initial-load+materialize/1000` | json-joy | 2 | 679.56 | 721.33 | 656.33 | 774.98 | 36766.00 |
| `initial-load+materialize/1000` | yjs-v2 | 2 | 556.50 | 604.87 | 534.19 | 611.15 | 30012.00 |
| `initial-load+materialize/1000` | loro | 2 | 1634.58 | 1842.96 | 1599.54 | 1920.79 | 49733.00 |
| `initial-load+materialize/1000` | yjs-v1 | 2 | 654.00 | 682.63 | 624.44 | 687.77 | 47879.00 |
| `offline-merge/100-per-peer` | pulsify | 1 | 143.33 | 186.83 | 88.67 | 223.96 | 176.00 |
| `offline-merge/100-per-peer` | json-joy | 1 | 85.83 | 125.25 | 71.00 | 132.33 | 139.00 |
| `offline-merge/100-per-peer` | yjs-v2 | 1 | 81.79 | 102.54 | 65.67 | 110.17 | 97.00 |
| `offline-merge/100-per-peer` | loro | 1 | 240.37 | 319.96 | 218.42 | 330.46 | 1624.00 |
| `offline-merge/100-per-peer` | yjs-v1 | 1 | 64.13 | 105.71 | 51.63 | 115.63 | 75.00 |
| `upstream-map-conflict/16-peers` | pulsify | 1 | 61.54 | 78.17 | 49.87 | 82.00 | 1728.00 |
| `upstream-map-conflict/16-peers` | json-joy | 1 | 60.17 | 104.54 | 50.08 | 153.46 | 1024.00 |
| `upstream-map-conflict/16-peers` | yjs-v2 | 1 | 95.46 | 116.29 | 75.62 | 116.67 | 512.00 |
| `upstream-map-conflict/16-peers` | loro | 1 | 391.46 | 463.79 | 359.08 | 494.29 | 1536.00 |
| `upstream-map-conflict/16-peers` | yjs-v1 | 1 | 78.08 | 105.17 | 64.37 | 117.25 | 336.00 |
| `proxy-overhead/read-count` | native-json-joy | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `proxy-overhead/read-count` | pulsify-direct | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `proxy-overhead/read-count` | pulsify-proxy | 10000 | 0.02 | 0.03 | 0.02 | 0.03 | — |
| `proxy-overhead/mutate-history-0` | native-json-joy | 200 | 0.30 | 0.33 | 0.27 | 0.35 | — |
| `proxy-overhead/mutate-history-0` | pulsify-direct | 200 | 0.24 | 0.34 | 0.22 | 0.41 | — |
| `proxy-overhead/mutate-history-0` | pulsify-proxy | 200 | 0.26 | 0.32 | 0.23 | 0.35 | — |
| `proxy-overhead/mutate-history-1000` | native-json-joy | 200 | 0.29 | 0.33 | 0.27 | 0.34 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-direct | 200 | 0.18 | 0.24 | 0.15 | 0.33 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-proxy | 200 | 0.19 | 0.24 | 0.15 | 0.36 | — |
| `proxy-overhead/mutate-history-5000` | native-json-joy | 200 | 0.28 | 0.33 | 0.26 | 0.46 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-direct | 200 | 0.17 | 0.18 | 0.15 | 0.21 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-proxy | 200 | 0.17 | 0.20 | 0.15 | 0.22 | — |
