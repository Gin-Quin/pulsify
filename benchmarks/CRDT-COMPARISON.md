# Pulsify, json-joy, Yjs et Loro : comparaison locale

Ce fichier est généré par `bun run bench:crdt`. Les données brutes sont dans le JSON indiqué par `--output` (par défaut `benchmarks/results/crdt-comparison.json`). La référence complète conservée est [baselines/core-hybrid-20261104.json](baselines/core-hybrid-20261104.json).



## Environnement et protocole

- Apple M4, arm64, darwin 25.3.0, 10 cœurs.
- bun-1.4.4, codec 2.1.0, json-joy 18.28.0, Yjs 13.6.33, loro-crdt 1.17.1 (wasm-nodejs).
- 5 échantillons d'échauffement puis 25 mesurés ; 95 résultats. Mode court : false. Filtre : `aucun`.
- Ordre des participants mélangé à chaque bloc avec une graine fixe (5370206). GC forcé avant et après la préparation de chaque échantillon, hors chronométrage : les allocations temporaires de l'historique de préparation ne sont pas imputées à la mutation mesurée. Chaque échantillon utilise un état neuf.
- Les durées sont des **médianes de moyennes par échantillon**, en µs/op. Le p95 final porte lui aussi sur ces moyennes et ne représente pas la latence p95 de chaque événement individuel.
- Mesure UTC : 2026-11-04T16:50:15.269Z. Commit de base : `3bfc576b2504ee88453ebbbff6ea639fa4836565`. Copie de travail modifiée : false.
- Moteur Pulsify : native-core-v3-hybrid. Schéma fourni explicitement : codec object: title string, nested count float64, items editable array of { value float64, label string }. Sa compilation et la définition sont préparées hors chronométrage ; les données et conteneurs éditables restent ceux de la suite initiale.
- Les schémas applicatifs compilent leurs codecs, copies et contrôles de valeurs. Pulsify exécute les contrôles des champs affectés avant leur commit ou application. Le décodage de l'enveloppe utilise codec directement, sans second parcours récursif de son schéma. Les limites de trame, références causales et règles de cohérence sont conservées.

## Temps comparés

Les mêmes champs et valeurs sont utilisés : métadonnées de document, chaîne atomique, map imbriquée modifiable et liste de maps à deux champs. Les conteneurs imbriqués sont des CRDT dans les quatre implémentations, pas des objets JSON opaques. Les références du champ imbriqué sont mises en cache pour les lectures et mutations scalaires.

| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create/10` | 11.01 | 12.43 | 15.60 | 57.29 | — |
| `create+encode/10` | 13.49 | 12.70 | 20.16 | 103.15 | 16.70 |
| `create/1000` | 263.02 | 450.12 | 323.90 | 3073.38 | — |
| `create+encode/1000` | 318.83 | 718.06 | 505.60 | 4741.62 | 543.52 |
| `export-first/1000` | 76.04 | 293.67 | 210.13 | 1711.96 | 265.58 |
| `export-repeat/1000` | 23.87 | 267.42 | 191.25 | 76.79 | 237.58 |
| `read-count/10` | 0.02 | 0.01 | 0.01 | 0.12 | — |
| `mutate/history-0` | 0.29 | 0.39 | 1.17 | 1.34 | — |
| `mutate/history-1000` | 0.19 | 0.30 | 0.94 | 1.25 | — |
| `mutate/history-5000` | 0.16 | 0.30 | 0.93 | 1.26 | — |
| `list-append/10` | 1.24 | 1.06 | 1.59 | 4.31 | — |
| `edit+encode/10` | 1.64 | 2.70 | 4.85 | 8.39 | 2.26 |
| `delta-roundtrip/10` | 3.45 | 4.53 | 7.73 | 15.90 | 3.95 |
| `delta-roundtrip/1000` | 12.42 | 154.69 | 26.67 | 47.15 | 21.85 |
| `initial-load+materialize/10` | 13.35 | 13.93 | 15.55 | 46.24 | 15.97 |
| `initial-load+materialize/1000` | 367.44 | 659.94 | 547.02 | 1624.77 | 635.10 |
| `offline-merge/100-per-peer` | 146.00 | 90.54 | 78.63 | 239.29 | 62.50 |
| `upstream-map-conflict/16-peers` | 62.54 | 63.37 | 99.87 | 392.75 | 76.46 |

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
| `proxy-overhead/mutate-history-0` | 0.31 | 0.24 | 0.26 | 0.02 |
| `proxy-overhead/mutate-history-1000` | 0.29 | 0.18 | 0.18 | -0.00 |
| `proxy-overhead/mutate-history-5000` | 0.28 | 0.15 | 0.16 | 0.00 |

Les écarts sont des différences de médianes observées, pas un profil instruction par instruction. Un petit écart ou un écart négatif peut être du bruit ou une différence d'optimisation JIT. La création et l'encodage du journal ne doivent donc pas être attribués intégralement aux proxies.

L'écart public − direct inclut aussi les contrôles et conversions du setter public. Il ne mesure pas seulement les instructions des traps JavaScript.

Sur la mutation scalaire sans historique préparé, l’API publique Pulsify prend 0.84 fois le temps de json-joy natif. L'écart proxy − pipeline est de 0.02 µs, soit 7.06 % du pipeline sans proxy. Le moteur Pulsify sans proxy prend 0.78 fois le temps natif : ce scénario distingue le coût du chemin public et celui de la mutation interne. Cette décomposition concerne le champ scalaire mis en cache, pas toutes les opérations de listes ou la création des vues.

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
| `create/10` | pulsify | 20 | 11.01 | 17.93 | 7.45 | 18.83 | — |
| `create/10` | json-joy | 20 | 12.43 | 17.18 | 9.63 | 20.37 | — |
| `create/10` | yjs-v2 | 20 | 15.60 | 23.35 | 10.35 | 26.91 | — |
| `create/10` | loro | 20 | 57.29 | 103.46 | 48.54 | 136.14 | — |
| `create+encode/10` | pulsify | 20 | 13.49 | 17.23 | 10.71 | 25.40 | 284.00 |
| `create+encode/10` | json-joy | 20 | 12.70 | 20.32 | 10.80 | 20.46 | 439.00 |
| `create+encode/10` | yjs-v2 | 20 | 20.16 | 24.20 | 15.40 | 25.77 | 449.00 |
| `create+encode/10` | loro | 20 | 103.15 | 147.92 | 88.38 | 157.17 | 1030.00 |
| `create+encode/10` | yjs-v1 | 20 | 16.70 | 24.00 | 12.83 | 26.32 | 593.00 |
| `create/1000` | pulsify | 2 | 263.02 | 338.15 | 235.21 | 344.17 | — |
| `create/1000` | json-joy | 2 | 450.12 | 529.10 | 432.23 | 606.06 | — |
| `create/1000` | yjs-v2 | 2 | 323.90 | 348.65 | 303.83 | 358.04 | — |
| `create/1000` | loro | 2 | 3073.38 | 3231.48 | 2987.17 | 3518.46 | — |
| `create+encode/1000` | pulsify | 2 | 318.83 | 361.73 | 292.08 | 392.10 | 17027.00 |
| `create+encode/1000` | json-joy | 2 | 718.06 | 763.02 | 691.73 | 778.02 | 36766.00 |
| `create+encode/1000` | yjs-v2 | 2 | 505.60 | 589.35 | 471.69 | 608.96 | 30012.00 |
| `create+encode/1000` | loro | 2 | 4741.62 | 5072.54 | 4588.08 | 5164.54 | 49733.00 |
| `create+encode/1000` | yjs-v1 | 2 | 543.52 | 608.44 | 516.83 | 608.83 | 47879.00 |
| `export-first/1000` | pulsify | 1 | 76.04 | 137.54 | 61.58 | 181.00 | 17027.00 |
| `export-first/1000` | json-joy | 1 | 293.67 | 342.88 | 265.21 | 348.38 | 36766.00 |
| `export-first/1000` | yjs-v2 | 1 | 210.13 | 312.04 | 185.83 | 312.58 | 30012.00 |
| `export-first/1000` | loro | 1 | 1711.96 | 1857.42 | 1658.63 | 1909.42 | 49733.00 |
| `export-first/1000` | yjs-v1 | 1 | 265.58 | 373.46 | 229.17 | 390.75 | 47879.00 |
| `export-repeat/1000` | pulsify | 1 | 23.87 | 44.21 | 17.42 | 47.42 | 17027.00 |
| `export-repeat/1000` | json-joy | 1 | 267.42 | 304.33 | 234.12 | 408.17 | 36766.00 |
| `export-repeat/1000` | yjs-v2 | 1 | 191.25 | 269.08 | 167.17 | 278.21 | 30012.00 |
| `export-repeat/1000` | loro | 1 | 76.79 | 101.58 | 69.42 | 112.96 | 49733.00 |
| `export-repeat/1000` | yjs-v1 | 1 | 237.58 | 322.54 | 211.58 | 323.67 | 47879.00 |
| `read-count/10` | pulsify | 10000 | 0.02 | 0.03 | 0.02 | 0.05 | — |
| `read-count/10` | json-joy | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `read-count/10` | yjs-v2 | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `read-count/10` | loro | 10000 | 0.12 | 0.13 | 0.12 | 0.13 | — |
| `mutate/history-0` | pulsify | 200 | 0.29 | 0.34 | 0.25 | 0.38 | — |
| `mutate/history-0` | json-joy | 200 | 0.39 | 0.45 | 0.35 | 0.50 | — |
| `mutate/history-0` | yjs-v2 | 200 | 1.17 | 1.43 | 1.06 | 1.55 | — |
| `mutate/history-0` | loro | 200 | 1.34 | 1.49 | 1.26 | 2.53 | — |
| `mutate/history-1000` | pulsify | 200 | 0.19 | 0.24 | 0.13 | 0.25 | — |
| `mutate/history-1000` | json-joy | 200 | 0.30 | 0.35 | 0.25 | 0.36 | — |
| `mutate/history-1000` | yjs-v2 | 200 | 0.94 | 1.01 | 0.86 | 1.07 | — |
| `mutate/history-1000` | loro | 200 | 1.25 | 1.32 | 1.21 | 1.33 | — |
| `mutate/history-5000` | pulsify | 200 | 0.16 | 0.21 | 0.14 | 0.28 | — |
| `mutate/history-5000` | json-joy | 200 | 0.30 | 0.35 | 0.25 | 0.42 | — |
| `mutate/history-5000` | yjs-v2 | 200 | 0.93 | 1.06 | 0.86 | 1.07 | — |
| `mutate/history-5000` | loro | 200 | 1.26 | 1.35 | 1.20 | 1.60 | — |
| `list-append/10` | pulsify | 100 | 1.24 | 1.82 | 0.97 | 1.86 | — |
| `list-append/10` | json-joy | 100 | 1.06 | 1.35 | 0.94 | 1.48 | — |
| `list-append/10` | yjs-v2 | 100 | 1.59 | 2.02 | 1.41 | 2.05 | — |
| `list-append/10` | loro | 100 | 4.31 | 4.60 | 4.18 | 4.90 | — |
| `edit+encode/10` | pulsify | 100 | 1.64 | 2.39 | 1.30 | 2.60 | 104.00 |
| `edit+encode/10` | json-joy | 100 | 2.70 | 3.51 | 2.51 | 3.62 | 58.79 |
| `edit+encode/10` | yjs-v2 | 100 | 4.85 | 5.30 | 4.49 | 5.64 | 33.44 |
| `edit+encode/10` | loro | 100 | 8.39 | 10.31 | 7.13 | 13.85 | 86.57 |
| `edit+encode/10` | yjs-v1 | 100 | 2.26 | 2.64 | 2.04 | 2.78 | 23.54 |
| `delta-roundtrip/10` | pulsify | 50 | 3.45 | 4.04 | 3.09 | 4.15 | 104.00 |
| `delta-roundtrip/10` | json-joy | 50 | 4.53 | 5.58 | 4.06 | 5.66 | 63.88 |
| `delta-roundtrip/10` | yjs-v2 | 50 | 7.73 | 8.52 | 7.11 | 9.20 | 32.94 |
| `delta-roundtrip/10` | loro | 50 | 15.90 | 17.70 | 14.79 | 24.49 | 86.00 |
| `delta-roundtrip/10` | yjs-v1 | 50 | 3.95 | 4.83 | 3.48 | 4.83 | 22.96 |
| `delta-roundtrip/1000` | pulsify | 5 | 12.42 | 15.75 | 10.15 | 16.86 | 104.00 |
| `delta-roundtrip/1000` | json-joy | 5 | 154.69 | 169.19 | 145.37 | 175.37 | 70.60 |
| `delta-roundtrip/1000` | yjs-v2 | 5 | 26.67 | 30.63 | 23.79 | 31.19 | 34.20 |
| `delta-roundtrip/1000` | loro | 5 | 47.15 | 66.70 | 39.67 | 76.80 | 88.00 |
| `delta-roundtrip/1000` | yjs-v1 | 5 | 21.85 | 30.44 | 19.62 | 31.22 | 25.20 |
| `initial-load+materialize/10` | pulsify | 10 | 13.35 | 14.83 | 10.70 | 14.86 | 284.00 |
| `initial-load+materialize/10` | json-joy | 10 | 13.93 | 16.02 | 11.29 | 17.32 | 439.00 |
| `initial-load+materialize/10` | yjs-v2 | 10 | 15.55 | 16.88 | 14.13 | 18.77 | 449.00 |
| `initial-load+materialize/10` | loro | 10 | 46.24 | 49.07 | 42.11 | 49.29 | 1030.00 |
| `initial-load+materialize/10` | yjs-v1 | 10 | 15.97 | 17.18 | 14.47 | 17.63 | 593.00 |
| `initial-load+materialize/1000` | pulsify | 2 | 367.44 | 418.94 | 348.98 | 430.48 | 17027.00 |
| `initial-load+materialize/1000` | json-joy | 2 | 659.94 | 730.13 | 635.13 | 756.31 | 36766.00 |
| `initial-load+materialize/1000` | yjs-v2 | 2 | 547.02 | 592.10 | 520.25 | 637.27 | 30012.00 |
| `initial-load+materialize/1000` | loro | 2 | 1624.77 | 1791.50 | 1585.46 | 1950.35 | 49733.00 |
| `initial-load+materialize/1000` | yjs-v1 | 2 | 635.10 | 709.71 | 619.10 | 728.35 | 47879.00 |
| `offline-merge/100-per-peer` | pulsify | 1 | 146.00 | 203.54 | 104.08 | 222.37 | 176.00 |
| `offline-merge/100-per-peer` | json-joy | 1 | 90.54 | 110.71 | 67.75 | 112.08 | 139.00 |
| `offline-merge/100-per-peer` | yjs-v2 | 1 | 78.63 | 109.04 | 62.58 | 112.67 | 97.00 |
| `offline-merge/100-per-peer` | loro | 1 | 239.29 | 273.83 | 217.42 | 318.33 | 1624.00 |
| `offline-merge/100-per-peer` | yjs-v1 | 1 | 62.50 | 81.37 | 49.62 | 128.83 | 75.00 |
| `upstream-map-conflict/16-peers` | pulsify | 1 | 62.54 | 85.29 | 41.58 | 98.63 | 1728.00 |
| `upstream-map-conflict/16-peers` | json-joy | 1 | 63.37 | 99.37 | 48.21 | 129.12 | 1024.00 |
| `upstream-map-conflict/16-peers` | yjs-v2 | 1 | 99.87 | 122.71 | 75.08 | 125.71 | 512.00 |
| `upstream-map-conflict/16-peers` | loro | 1 | 392.75 | 461.21 | 368.13 | 480.21 | 1536.00 |
| `upstream-map-conflict/16-peers` | yjs-v1 | 1 | 76.46 | 121.58 | 65.29 | 127.12 | 336.00 |
| `proxy-overhead/read-count` | native-json-joy | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `proxy-overhead/read-count` | pulsify-direct | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `proxy-overhead/read-count` | pulsify-proxy | 10000 | 0.02 | 0.03 | 0.02 | 0.03 | — |
| `proxy-overhead/mutate-history-0` | native-json-joy | 200 | 0.31 | 0.35 | 0.29 | 0.41 | — |
| `proxy-overhead/mutate-history-0` | pulsify-direct | 200 | 0.24 | 0.36 | 0.22 | 0.40 | — |
| `proxy-overhead/mutate-history-0` | pulsify-proxy | 200 | 0.26 | 0.33 | 0.23 | 0.34 | — |
| `proxy-overhead/mutate-history-1000` | native-json-joy | 200 | 0.29 | 0.34 | 0.27 | 0.35 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-direct | 200 | 0.18 | 0.22 | 0.13 | 0.31 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-proxy | 200 | 0.18 | 0.24 | 0.15 | 0.26 | — |
| `proxy-overhead/mutate-history-5000` | native-json-joy | 200 | 0.28 | 0.31 | 0.26 | 0.31 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-direct | 200 | 0.15 | 0.18 | 0.14 | 0.18 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-proxy | 200 | 0.16 | 0.18 | 0.14 | 0.19 | — |
