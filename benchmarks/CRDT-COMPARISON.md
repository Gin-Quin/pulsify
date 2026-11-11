# Pulsify, json-joy, Yjs et Loro : comparaison locale

Ce fichier est généré par `bun run bench:crdt`. Les données brutes sont dans le JSON indiqué par `--output` (par défaut `benchmarks/results/crdt-comparison.json`). La référence complète conservée est [baselines/core-compact-20261111.json](baselines/core-compact-20261111.json).



## Environnement et protocole

- Apple M4, arm64, darwin 25.3.0, 10 cœurs.
- bun-1.4.4, codec 2.1.1, json-joy 18.28.0, Yjs 13.6.33, loro-crdt 1.17.1 (wasm-nodejs).
- 5 échantillons d'échauffement puis 25 mesurés ; 95 résultats. Mode court : false. Filtre : `aucun`.
- Ordre des participants mélangé à chaque bloc avec une graine fixe (5370206). GC forcé avant et après la préparation de chaque échantillon, hors chronométrage : les allocations temporaires de l'historique de préparation ne sont pas imputées à la mutation mesurée. Chaque échantillon utilise un état neuf.
- Les durées sont des **médianes de moyennes par échantillon**, en µs/op. Le p95 final porte lui aussi sur ces moyennes et ne représente pas la latence p95 de chaque événement individuel.
- Mesure UTC : 2026-11-11T19:05:49.358Z. Commit de base : `45719ea7822c355b16fbaec0e85ef702ef222a4a`. Copie de travail modifiée : true.
- Moteur Pulsify : native-core-v4-hybrid-compact. Schéma fourni explicitement : codec object: title string, nested count float64, items editable array of { value float64, label string }. Sa compilation et la définition sont préparées hors chronométrage ; les données et conteneurs éditables restent ceux de la suite initiale.
- Les schémas applicatifs compilent leurs codecs, copies et contrôles de valeurs. Pulsify exécute les contrôles des champs affectés avant leur commit ou application. Le décodage de l'enveloppe utilise codec directement, sans second parcours récursif de son schéma. Les limites de trame, références causales et règles de cohérence sont conservées.

## Temps comparés

Les mêmes champs et valeurs sont utilisés : métadonnées de document, chaîne atomique, map imbriquée modifiable et liste de maps à deux champs. Les conteneurs imbriqués sont des CRDT dans les quatre implémentations, pas des objets JSON opaques. Les références du champ imbriqué sont mises en cache pour les lectures et mutations scalaires.

| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create/10` | 10.11 | 10.83 | 14.19 | 53.67 | — |
| `create+encode/10` | 13.75 | 11.59 | 19.52 | 103.31 | 15.65 |
| `create/1000` | 271.56 | 452.42 | 322.79 | 3075.77 | — |
| `create+encode/1000` | 320.35 | 717.69 | 495.75 | 4761.21 | 551.92 |
| `export-first/1000` | 69.63 | 289.50 | 193.33 | 1714.42 | 254.54 |
| `export-repeat/1000` | 20.75 | 274.33 | 177.08 | 74.67 | 236.67 |
| `read-count/10` | 0.02 | 0.01 | 0.01 | 0.13 | — |
| `mutate/history-0` | 0.27 | 0.38 | 1.12 | 1.31 | — |
| `mutate/history-1000` | 0.17 | 0.28 | 0.91 | 1.25 | — |
| `mutate/history-5000` | 0.14 | 0.27 | 0.88 | 1.25 | — |
| `list-append/10` | 1.01 | 1.00 | 1.51 | 4.28 | — |
| `edit+encode/10` | 1.33 | 2.68 | 5.12 | 8.49 | 2.34 |
| `delta-roundtrip/10` | 2.90 | 4.36 | 7.90 | 15.61 | 4.07 |
| `delta-roundtrip/1000` | 11.75 | 154.09 | 28.80 | 46.76 | 21.84 |
| `initial-load+materialize/10` | 17.72 | 15.18 | 15.60 | 47.15 | 16.63 |
| `initial-load+materialize/1000` | 394.29 | 671.81 | 520.94 | 1653.40 | 622.81 |
| `offline-merge/100-per-peer` | 131.54 | 82.13 | 79.04 | 234.50 | 65.17 |
| `upstream-map-conflict/16-peers` | 70.71 | 60.00 | 96.67 | 394.92 | 83.58 |

## Taille des représentations transférées

Octets moyens par opération mesurée. Pour `offline-merge`, la valeur est la somme des deux deltas ; pour le conflit à 16 pairs, la somme des deltas importés par un seul récepteur. Ces octets sont des charges utiles, hors TCP/WebSocket/TLS.

| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create+encode/10` | 284.00 | 439.00 | 449.00 | 1030.00 | 593.00 |
| `create+encode/1000` | 17027.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `export-first/1000` | 17027.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `export-repeat/1000` | 17027.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `edit+encode/10` | 24.00 | 58.79 | 33.44 | 86.57 | 23.54 |
| `delta-roundtrip/10` | 24.00 | 63.88 | 32.94 | 86.00 | 22.96 |
| `delta-roundtrip/1000` | 24.00 | 70.60 | 34.20 | 88.00 | 25.20 |
| `initial-load+materialize/10` | 284.00 | 439.00 | 449.00 | 1030.00 | 593.00 |
| `initial-load+materialize/1000` | 17027.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `offline-merge/100-per-peer` | 176.00 | 139.00 | 97.00 | 1624.00 | 75.00 |
| `upstream-map-conflict/16-peers` | 464.00 | 1024.00 | 512.00 | 1536.00 | 336.00 |

Les représentations ne retiennent pas toutes le même historique : Pulsify conserve le journal exact au producteur et peut transmettre un état scalaire condensé avec des vecteurs d’état et d’historique distincts, ou une écriture scalaire isolée dans une trame compacte que le récepteur reconstruit à l’identique ; json-joy natif utilise ses snapshots structurels et deltas ; Yjs utilise son état avec le GC activé par défaut ; Loro utilise un snapshot avec historique, puis des updates. Aucun snapshot superficiel Loro ni stockage supplémentaire pour restaurer les anciennes versions Yjs n'est ajouté.

## Isolation du coût des proxies

Le pipeline « sans proxy » utilise la même instance Pulsify et le même chemin de commit et de journal que le proxy public, mais appelle directement `CoreModel.set` pour le champ scalaire. Aucun encodage n'est effectué dans ces écritures locales. Un test exporte ensuite les deux historiques et vérifie **exactement les mêmes octets**. La différence avec json-joy natif comprend les autres services de Pulsify et son chemin de mutation, pas seulement les proxies.

| Scénario | json-joy natif | Pipeline Pulsify sans proxy | Pulsify avec proxy | Écart proxy − pipeline |
| --- | ---: | ---: | ---: | ---: |
| `proxy-overhead/read-count` | 0.01 | 0.01 | 0.03 | 0.02 |
| `proxy-overhead/mutate-history-0` | 0.33 | 0.26 | 0.28 | 0.02 |
| `proxy-overhead/mutate-history-1000` | 0.30 | 0.21 | 0.22 | 0.01 |
| `proxy-overhead/mutate-history-5000` | 0.27 | 0.17 | 0.18 | 0.00 |

Les écarts sont des différences de médianes observées, pas un profil instruction par instruction. Un petit écart ou un écart négatif peut être du bruit ou une différence d'optimisation JIT. La création et l'encodage du journal ne doivent donc pas être attribués intégralement aux proxies.

L'écart public − direct inclut aussi les contrôles et conversions du setter public. Il ne mesure pas seulement les instructions des traps JavaScript.

Sur la mutation scalaire sans historique préparé, l’API publique Pulsify prend 0.85 fois le temps de json-joy natif. L'écart proxy − pipeline est de 0.02 µs, soit 8.04 % du pipeline sans proxy. Le moteur Pulsify sans proxy prend 0.79 fois le temps natif : ce scénario distingue le coût du chemin public et celui de la mutation interne. Cette décomposition concerne le champ scalaire mis en cache, pas toutes les opérations de listes ou la création des vues.

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
- L'adaptateur json-joy exporte un delta structurel via `model.delta(vecteur)` ; Pulsify utilise son échange public v4, avec trame compacte pour une écriture scalaire isolée, état condensé pour les longues séries scalaires et opérations exactes sinon. La trame compacte ne circule qu’entre deux pulses : les sessions de connecteurs, relais et bases conservent les lignes exactes. Un bon résultat de Pulsify sur cet échange ne signifie donc pas que ses proxies exécutent les opérations natives plus vite. Le tableau des trois couches isole les écritures locales.
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
| `create/10` | pulsify | 20 | 10.11 | 14.69 | 7.50 | 19.17 | — |
| `create/10` | json-joy | 20 | 10.83 | 14.11 | 8.17 | 19.37 | — |
| `create/10` | yjs-v2 | 20 | 14.19 | 16.82 | 11.08 | 23.27 | — |
| `create/10` | loro | 20 | 53.67 | 100.45 | 46.39 | 124.51 | — |
| `create+encode/10` | pulsify | 20 | 13.75 | 16.75 | 11.44 | 16.98 | 284.00 |
| `create+encode/10` | json-joy | 20 | 11.59 | 15.47 | 9.38 | 18.65 | 439.00 |
| `create+encode/10` | yjs-v2 | 20 | 19.52 | 24.25 | 15.99 | 25.00 | 449.00 |
| `create+encode/10` | loro | 20 | 103.31 | 157.93 | 86.25 | 164.88 | 1030.00 |
| `create+encode/10` | yjs-v1 | 20 | 15.65 | 19.41 | 13.46 | 19.63 | 593.00 |
| `create/1000` | pulsify | 2 | 271.56 | 282.90 | 252.96 | 285.21 | — |
| `create/1000` | json-joy | 2 | 452.42 | 470.94 | 445.92 | 472.96 | — |
| `create/1000` | yjs-v2 | 2 | 322.79 | 337.92 | 310.85 | 350.79 | — |
| `create/1000` | loro | 2 | 3075.77 | 3140.67 | 2993.10 | 3209.94 | — |
| `create+encode/1000` | pulsify | 2 | 320.35 | 341.40 | 308.44 | 348.48 | 17027.00 |
| `create+encode/1000` | json-joy | 2 | 717.69 | 731.10 | 701.73 | 737.67 | 36766.00 |
| `create+encode/1000` | yjs-v2 | 2 | 495.75 | 513.81 | 477.13 | 566.60 | 30012.00 |
| `create+encode/1000` | loro | 2 | 4761.21 | 4840.65 | 4655.79 | 4910.69 | 49733.00 |
| `create+encode/1000` | yjs-v1 | 2 | 551.92 | 581.65 | 534.46 | 639.92 | 47879.00 |
| `export-first/1000` | pulsify | 1 | 69.63 | 81.67 | 60.63 | 126.08 | 17027.00 |
| `export-first/1000` | json-joy | 1 | 289.50 | 325.54 | 271.17 | 330.00 | 36766.00 |
| `export-first/1000` | yjs-v2 | 1 | 193.33 | 217.75 | 180.83 | 253.29 | 30012.00 |
| `export-first/1000` | loro | 1 | 1714.42 | 1781.75 | 1671.17 | 1791.29 | 49733.00 |
| `export-first/1000` | yjs-v1 | 1 | 254.54 | 273.50 | 239.04 | 278.71 | 47879.00 |
| `export-repeat/1000` | pulsify | 1 | 20.75 | 36.87 | 16.08 | 38.50 | 17027.00 |
| `export-repeat/1000` | json-joy | 1 | 274.33 | 291.92 | 256.42 | 296.96 | 36766.00 |
| `export-repeat/1000` | yjs-v2 | 1 | 177.08 | 190.37 | 162.37 | 194.75 | 30012.00 |
| `export-repeat/1000` | loro | 1 | 74.67 | 88.79 | 67.17 | 111.92 | 49733.00 |
| `export-repeat/1000` | yjs-v1 | 1 | 236.67 | 252.71 | 227.92 | 253.17 | 47879.00 |
| `read-count/10` | pulsify | 10000 | 0.02 | 0.03 | 0.02 | 0.05 | — |
| `read-count/10` | json-joy | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `read-count/10` | yjs-v2 | 10000 | 0.01 | 0.01 | 0.01 | 0.02 | — |
| `read-count/10` | loro | 10000 | 0.13 | 0.13 | 0.12 | 0.13 | — |
| `mutate/history-0` | pulsify | 200 | 0.27 | 0.30 | 0.25 | 0.34 | — |
| `mutate/history-0` | json-joy | 200 | 0.38 | 0.44 | 0.35 | 0.46 | — |
| `mutate/history-0` | yjs-v2 | 200 | 1.12 | 1.35 | 1.06 | 1.36 | — |
| `mutate/history-0` | loro | 200 | 1.31 | 1.45 | 1.25 | 1.65 | — |
| `mutate/history-1000` | pulsify | 200 | 0.17 | 0.21 | 0.13 | 0.21 | — |
| `mutate/history-1000` | json-joy | 200 | 0.28 | 0.35 | 0.25 | 0.35 | — |
| `mutate/history-1000` | yjs-v2 | 200 | 0.91 | 1.01 | 0.84 | 1.08 | — |
| `mutate/history-1000` | loro | 200 | 1.25 | 1.31 | 1.21 | 1.31 | — |
| `mutate/history-5000` | pulsify | 200 | 0.14 | 0.16 | 0.13 | 0.17 | — |
| `mutate/history-5000` | json-joy | 200 | 0.27 | 0.30 | 0.25 | 0.35 | — |
| `mutate/history-5000` | yjs-v2 | 200 | 0.88 | 1.01 | 0.81 | 1.01 | — |
| `mutate/history-5000` | loro | 200 | 1.25 | 1.41 | 1.20 | 1.49 | — |
| `list-append/10` | pulsify | 100 | 1.01 | 1.95 | 0.86 | 1.97 | — |
| `list-append/10` | json-joy | 100 | 1.00 | 1.41 | 0.91 | 1.43 | — |
| `list-append/10` | yjs-v2 | 100 | 1.51 | 1.79 | 1.38 | 1.96 | — |
| `list-append/10` | loro | 100 | 4.28 | 4.49 | 4.17 | 4.61 | — |
| `edit+encode/10` | pulsify | 100 | 1.33 | 2.06 | 1.05 | 2.77 | 24.00 |
| `edit+encode/10` | json-joy | 100 | 2.68 | 3.53 | 2.45 | 3.62 | 58.79 |
| `edit+encode/10` | yjs-v2 | 100 | 5.12 | 5.46 | 4.87 | 5.84 | 33.44 |
| `edit+encode/10` | loro | 100 | 8.49 | 10.71 | 7.18 | 11.29 | 86.57 |
| `edit+encode/10` | yjs-v1 | 100 | 2.34 | 2.52 | 2.10 | 2.57 | 23.54 |
| `delta-roundtrip/10` | pulsify | 50 | 2.90 | 3.11 | 2.66 | 3.18 | 24.00 |
| `delta-roundtrip/10` | json-joy | 50 | 4.36 | 4.96 | 4.07 | 5.08 | 63.88 |
| `delta-roundtrip/10` | yjs-v2 | 50 | 7.90 | 8.45 | 7.43 | 8.68 | 32.94 |
| `delta-roundtrip/10` | loro | 50 | 15.61 | 17.17 | 14.70 | 18.45 | 86.00 |
| `delta-roundtrip/10` | yjs-v1 | 50 | 4.07 | 4.43 | 3.67 | 5.23 | 22.96 |
| `delta-roundtrip/1000` | pulsify | 5 | 11.75 | 13.57 | 9.42 | 14.63 | 24.00 |
| `delta-roundtrip/1000` | json-joy | 5 | 154.09 | 166.58 | 147.81 | 175.19 | 70.60 |
| `delta-roundtrip/1000` | yjs-v2 | 5 | 28.80 | 31.32 | 25.25 | 31.70 | 34.20 |
| `delta-roundtrip/1000` | loro | 5 | 46.76 | 57.22 | 43.52 | 64.23 | 88.00 |
| `delta-roundtrip/1000` | yjs-v1 | 5 | 21.84 | 23.73 | 19.41 | 25.22 | 25.20 |
| `initial-load+materialize/10` | pulsify | 10 | 17.72 | 21.41 | 15.07 | 21.79 | 284.00 |
| `initial-load+materialize/10` | json-joy | 10 | 15.18 | 17.35 | 13.35 | 17.90 | 439.00 |
| `initial-load+materialize/10` | yjs-v2 | 10 | 15.60 | 17.12 | 14.41 | 17.78 | 449.00 |
| `initial-load+materialize/10` | loro | 10 | 47.15 | 51.59 | 45.17 | 54.40 | 1030.00 |
| `initial-load+materialize/10` | yjs-v1 | 10 | 16.63 | 17.32 | 14.75 | 17.70 | 593.00 |
| `initial-load+materialize/1000` | pulsify | 2 | 394.29 | 418.40 | 371.69 | 462.98 | 17027.00 |
| `initial-load+materialize/1000` | json-joy | 2 | 671.81 | 691.96 | 659.65 | 725.65 | 36766.00 |
| `initial-load+materialize/1000` | yjs-v2 | 2 | 520.94 | 566.12 | 501.98 | 596.98 | 30012.00 |
| `initial-load+materialize/1000` | loro | 2 | 1653.40 | 1799.19 | 1616.75 | 2054.13 | 49733.00 |
| `initial-load+materialize/1000` | yjs-v1 | 2 | 622.81 | 645.58 | 596.46 | 715.83 | 47879.00 |
| `offline-merge/100-per-peer` | pulsify | 1 | 131.54 | 173.62 | 95.67 | 181.58 | 176.00 |
| `offline-merge/100-per-peer` | json-joy | 1 | 82.13 | 114.00 | 59.33 | 114.00 | 139.00 |
| `offline-merge/100-per-peer` | yjs-v2 | 1 | 79.04 | 94.46 | 61.87 | 111.04 | 97.00 |
| `offline-merge/100-per-peer` | loro | 1 | 234.50 | 297.38 | 211.12 | 327.04 | 1624.00 |
| `offline-merge/100-per-peer` | yjs-v1 | 1 | 65.17 | 83.46 | 57.54 | 85.08 | 75.00 |
| `upstream-map-conflict/16-peers` | pulsify | 1 | 70.71 | 99.13 | 55.50 | 101.12 | 464.00 |
| `upstream-map-conflict/16-peers` | json-joy | 1 | 60.00 | 74.79 | 53.17 | 75.17 | 1024.00 |
| `upstream-map-conflict/16-peers` | yjs-v2 | 1 | 96.67 | 118.17 | 86.04 | 130.04 | 512.00 |
| `upstream-map-conflict/16-peers` | loro | 1 | 394.92 | 441.04 | 371.92 | 472.00 | 1536.00 |
| `upstream-map-conflict/16-peers` | yjs-v1 | 1 | 83.58 | 90.42 | 66.33 | 92.21 | 336.00 |
| `proxy-overhead/read-count` | native-json-joy | 10000 | 0.01 | 0.03 | 0.01 | 0.03 | — |
| `proxy-overhead/read-count` | pulsify-direct | 10000 | 0.01 | 0.03 | 0.01 | 0.03 | — |
| `proxy-overhead/read-count` | pulsify-proxy | 10000 | 0.03 | 0.04 | 0.02 | 0.07 | — |
| `proxy-overhead/mutate-history-0` | native-json-joy | 200 | 0.33 | 0.39 | 0.30 | 0.46 | — |
| `proxy-overhead/mutate-history-0` | pulsify-direct | 200 | 0.26 | 0.29 | 0.23 | 0.40 | — |
| `proxy-overhead/mutate-history-0` | pulsify-proxy | 200 | 0.28 | 0.30 | 0.25 | 0.31 | — |
| `proxy-overhead/mutate-history-1000` | native-json-joy | 200 | 0.30 | 0.33 | 0.28 | 0.33 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-direct | 200 | 0.21 | 0.29 | 0.19 | 0.36 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-proxy | 200 | 0.22 | 0.57 | 0.19 | 0.63 | — |
| `proxy-overhead/mutate-history-5000` | native-json-joy | 200 | 0.27 | 0.30 | 0.26 | 0.31 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-direct | 200 | 0.17 | 0.21 | 0.16 | 0.21 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-proxy | 200 | 0.18 | 0.22 | 0.16 | 0.28 | — |
