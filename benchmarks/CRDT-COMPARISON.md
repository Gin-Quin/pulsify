# Pulsify, json-joy, Yjs et Loro : comparaison locale

Ce fichier est généré par `bun run bench:crdt`. Les données brutes sont dans le JSON indiqué par `--output` (par défaut `benchmarks/results/crdt-comparison.json`). La référence complète conservée est [baselines/core-native-20261104.json](baselines/core-native-20261104.json).



## Environnement et protocole

- Apple M4, arm64, darwin 25.3.0, 10 cœurs.
- bun-1.4.4, codec 2.1.0, json-joy 18.28.0, Yjs 13.6.33, loro-crdt 1.17.1 (wasm-nodejs).
- 5 échantillons d'échauffement puis 25 mesurés ; 95 résultats. Mode court : false. Filtre : `aucun`.
- Ordre des participants mélangé à chaque bloc avec une graine fixe (5370206). GC forcé avant et après la préparation de chaque échantillon, hors chronométrage : les allocations temporaires de l'historique de préparation ne sont pas imputées à la mutation mesurée. Chaque échantillon utilise un état neuf.
- Les durées sont des **médianes de moyennes par échantillon**, en µs/op. Le p95 final porte lui aussi sur ces moyennes et ne représente pas la latence p95 de chaque événement individuel.
- Mesure UTC : 2026-11-04T04:25:06.313Z. Commit de base : `713b7db54c01dfb176deb8efb65cb0e3251b40ad`. Copie de travail modifiée : false.
- Moteur Pulsify : native-core-v2. Schéma fourni explicitement : codec object: title string, nested count float64, items editable array of { value float64, label string }. Sa compilation et la définition sont préparées hors chronométrage ; les données et conteneurs éditables restent ceux de la suite initiale.
- Les schémas applicatifs compilent leurs codecs, copies et contrôles de valeurs. Pulsify exécute les contrôles des champs affectés avant leur commit ou application. Le décodage de l'enveloppe utilise codec directement, sans second parcours récursif de son schéma. Les limites de trame, références causales et règles de cohérence sont conservées.

## Temps comparés

Les mêmes champs et valeurs sont utilisés : métadonnées de document, chaîne atomique, map imbriquée modifiable et liste de maps à deux champs. Les conteneurs imbriqués sont des CRDT dans les quatre implémentations, pas des objets JSON opaques. Les références du champ imbriqué sont mises en cache pour les lectures et mutations scalaires.

| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create/10` | 7.71 | 10.16 | 12.33 | 49.73 | — |
| `create+encode/10` | 11.35 | 11.71 | 18.44 | 94.43 | 14.76 |
| `create/1000` | 250.65 | 425.52 | 302.13 | 2946.67 | — |
| `create+encode/1000` | 293.58 | 669.88 | 461.06 | 4552.81 | 512.00 |
| `export-first/1000` | 57.42 | 266.67 | 182.96 | 1630.50 | 235.21 |
| `export-repeat/1000` | 14.33 | 248.33 | 155.83 | 70.75 | 211.96 |
| `read-count/10` | 0.02 | 0.01 | 0.01 | 0.13 | — |
| `mutate/history-0` | 0.27 | 0.34 | 1.22 | 1.25 | — |
| `mutate/history-1000` | 0.25 | 0.29 | 0.91 | 1.20 | — |
| `mutate/history-5000` | 0.23 | 0.26 | 0.85 | 1.13 | — |
| `list-append/10` | 1.03 | 0.94 | 1.48 | 4.15 | — |
| `edit+encode/10` | 1.29 | 2.59 | 4.64 | 7.95 | 2.19 |
| `delta-roundtrip/10` | 3.19 | 4.26 | 7.45 | 15.03 | 3.89 |
| `delta-roundtrip/1000` | 10.28 | 146.05 | 25.04 | 44.33 | 20.23 |
| `initial-load+materialize/10` | 13.80 | 14.05 | 14.91 | 46.37 | 16.06 |
| `initial-load+materialize/1000` | 364.29 | 648.17 | 546.35 | 1617.35 | 644.42 |
| `offline-merge/100-per-peer` | 423.33 | 85.71 | 82.62 | 237.67 | 66.58 |
| `upstream-map-conflict/16-peers` | 64.37 | 62.67 | 90.46 | 396.12 | 78.87 |

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
| `offline-merge/100-per-peer` | 17334.00 | 139.00 | 97.00 | 1624.00 | 75.00 |
| `upstream-map-conflict/16-peers` | 1728.00 | 1024.00 | 512.00 | 1536.00 | 336.00 |

Les représentations ne retiennent pas toutes le même historique : Pulsify transmet son journal de segments dans des messages validés avec identifiant et vecteurs ; json-joy natif utilise ses snapshots structurels et deltas ; Yjs utilise son état avec le GC activé par défaut ; Loro utilise un snapshot avec historique, puis des updates. Aucun snapshot superficiel Loro ni stockage supplémentaire pour restaurer les anciennes versions Yjs n'est ajouté.

## Isolation du coût des proxies

Le pipeline « sans proxy » utilise la même instance Pulsify et le même chemin de commit et de journal que le proxy public, mais appelle directement `CoreModel.set` pour le champ scalaire. Aucun encodage n'est effectué dans ces écritures locales. Un test exporte ensuite les deux historiques et vérifie **exactement les mêmes octets**. La différence avec json-joy natif comprend les autres services de Pulsify et son chemin de mutation, pas seulement les proxies.

| Scénario | json-joy natif | Pipeline Pulsify sans proxy | Pulsify avec proxy | Écart proxy − pipeline |
| --- | ---: | ---: | ---: | ---: |
| `proxy-overhead/read-count` | 0.01 | 0.01 | 0.02 | 0.01 |
| `proxy-overhead/mutate-history-0` | 0.29 | 0.23 | 0.23 | 0.01 |
| `proxy-overhead/mutate-history-1000` | 0.28 | 0.22 | 0.24 | 0.02 |
| `proxy-overhead/mutate-history-5000` | 0.25 | 0.23 | 0.25 | 0.01 |

Les écarts sont des différences de médianes observées, pas un profil instruction par instruction. Un petit écart ou un écart négatif peut être du bruit ou une différence d'optimisation JIT. La création et l'encodage du journal ne doivent donc pas être attribués intégralement aux proxies.

L'écart public − direct inclut aussi les contrôles et conversions du setter public. Il ne mesure pas seulement les instructions des traps JavaScript.

Sur la mutation scalaire sans historique préparé, l’API publique Pulsify prend 0.80 fois le temps de json-joy natif. L'écart proxy − pipeline est de 0.01 µs, soit 2.76 % du pipeline sans proxy. Le moteur Pulsify sans proxy prend 0.78 fois le temps natif : ce scénario distingue le coût du chemin public et celui de la mutation interne. Cette décomposition concerne le champ scalaire mis en cache, pas toutes les opérations de listes ou la création des vues.

Pulsify utilise son propre moteur : registres LWW pour les champs et RGA pour les listes. Aucun moteur json-joy ou Yjs ne se trouve dans son chemin d’exécution. L’import prévalide les références et modifications puis applique chaque patch, sans cloner le document entier. Les métadonnées de racine sont vérifiées lors de leur création ou modification. Les migrations ne lisent et ne copient la vue que si une migration est réellement nécessaire ([PulseRuntime.ts](../packages/pulse/source/pulses/PulseRuntime.ts)). Sans matérialiseur personnalisé, le snapshot utilise une copie spécialisée du schéma lorsque la forme de la vue le permet et conserve une copie générale sinon. Un matérialiseur conserve son parcours public. La taille élevée après 100 éditions hors ligne reflète la conservation de chaque segment, tandis que les formats structurels peuvent condenser les valeurs écrasées.

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
- L'adaptateur json-joy exporte un delta structurel via `model.delta(vecteur)` ; Pulsify exporte les opérations déjà conservées dans son journal. Un bon résultat de Pulsify sur cet échange ne signifie donc pas que ses proxies exécutent les opérations natives plus vite. Le tableau des trois couches isole les écritures locales.
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
| `create/10` | pulsify | 20 | 7.71 | 17.65 | 6.21 | 18.36 | — |
| `create/10` | json-joy | 20 | 10.16 | 18.12 | 8.20 | 22.24 | — |
| `create/10` | yjs-v2 | 20 | 12.33 | 17.04 | 9.98 | 21.12 | — |
| `create/10` | loro | 20 | 49.73 | 71.25 | 43.41 | 113.21 | — |
| `create+encode/10` | pulsify | 20 | 11.35 | 16.91 | 9.43 | 17.54 | 284.00 |
| `create+encode/10` | json-joy | 20 | 11.71 | 17.11 | 9.21 | 20.80 | 439.00 |
| `create+encode/10` | yjs-v2 | 20 | 18.44 | 21.90 | 14.48 | 23.36 | 449.00 |
| `create+encode/10` | loro | 20 | 94.43 | 136.18 | 82.31 | 138.21 | 1030.00 |
| `create+encode/10` | yjs-v1 | 20 | 14.76 | 19.12 | 11.23 | 19.45 | 593.00 |
| `create/1000` | pulsify | 2 | 250.65 | 338.10 | 226.71 | 342.42 | — |
| `create/1000` | json-joy | 2 | 425.52 | 467.08 | 401.15 | 472.38 | — |
| `create/1000` | yjs-v2 | 2 | 302.13 | 350.56 | 285.65 | 362.10 | — |
| `create/1000` | loro | 2 | 2946.67 | 3053.27 | 2836.19 | 3104.33 | — |
| `create+encode/1000` | pulsify | 2 | 293.58 | 328.19 | 268.10 | 367.90 | 17027.00 |
| `create+encode/1000` | json-joy | 2 | 669.88 | 724.50 | 647.87 | 727.69 | 36766.00 |
| `create+encode/1000` | yjs-v2 | 2 | 461.06 | 508.81 | 439.19 | 550.35 | 30012.00 |
| `create+encode/1000` | loro | 2 | 4552.81 | 4698.81 | 4460.17 | 4718.19 | 49733.00 |
| `create+encode/1000` | yjs-v1 | 2 | 512.00 | 536.85 | 494.79 | 645.90 | 47879.00 |
| `export-first/1000` | pulsify | 1 | 57.42 | 75.83 | 51.12 | 77.42 | 17027.00 |
| `export-first/1000` | json-joy | 1 | 266.67 | 311.58 | 249.04 | 338.79 | 36766.00 |
| `export-first/1000` | yjs-v2 | 1 | 182.96 | 228.33 | 160.33 | 336.92 | 30012.00 |
| `export-first/1000` | loro | 1 | 1630.50 | 1732.79 | 1581.04 | 1764.54 | 49733.00 |
| `export-first/1000` | yjs-v1 | 1 | 235.21 | 260.75 | 219.21 | 278.50 | 47879.00 |
| `export-repeat/1000` | pulsify | 1 | 14.33 | 20.54 | 10.92 | 27.42 | 17027.00 |
| `export-repeat/1000` | json-joy | 1 | 248.33 | 271.00 | 229.79 | 282.58 | 36766.00 |
| `export-repeat/1000` | yjs-v2 | 1 | 155.83 | 174.00 | 143.79 | 178.37 | 30012.00 |
| `export-repeat/1000` | loro | 1 | 70.75 | 91.46 | 65.29 | 102.13 | 49733.00 |
| `export-repeat/1000` | yjs-v1 | 1 | 211.96 | 247.12 | 200.38 | 252.04 | 47879.00 |
| `read-count/10` | pulsify | 10000 | 0.02 | 0.03 | 0.02 | 0.05 | — |
| `read-count/10` | json-joy | 10000 | 0.01 | 0.01 | 0.00 | 0.01 | — |
| `read-count/10` | yjs-v2 | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `read-count/10` | loro | 10000 | 0.13 | 0.13 | 0.12 | 0.13 | — |
| `mutate/history-0` | pulsify | 200 | 0.27 | 0.31 | 0.20 | 0.31 | — |
| `mutate/history-0` | json-joy | 200 | 0.34 | 0.43 | 0.32 | 0.49 | — |
| `mutate/history-0` | yjs-v2 | 200 | 1.22 | 1.41 | 0.95 | 1.50 | — |
| `mutate/history-0` | loro | 200 | 1.25 | 1.47 | 1.15 | 1.64 | — |
| `mutate/history-1000` | pulsify | 200 | 0.25 | 0.31 | 0.21 | 0.32 | — |
| `mutate/history-1000` | json-joy | 200 | 0.29 | 0.35 | 0.24 | 0.36 | — |
| `mutate/history-1000` | yjs-v2 | 200 | 0.91 | 1.00 | 0.81 | 1.00 | — |
| `mutate/history-1000` | loro | 200 | 1.20 | 1.27 | 1.11 | 1.30 | — |
| `mutate/history-5000` | pulsify | 200 | 0.23 | 0.28 | 0.19 | 0.29 | — |
| `mutate/history-5000` | json-joy | 200 | 0.26 | 0.31 | 0.23 | 0.35 | — |
| `mutate/history-5000` | yjs-v2 | 200 | 0.85 | 0.96 | 0.79 | 1.00 | — |
| `mutate/history-5000` | loro | 200 | 1.13 | 1.25 | 1.08 | 1.33 | — |
| `list-append/10` | pulsify | 100 | 1.03 | 1.88 | 0.85 | 1.88 | — |
| `list-append/10` | json-joy | 100 | 0.94 | 1.42 | 0.87 | 1.60 | — |
| `list-append/10` | yjs-v2 | 100 | 1.48 | 1.71 | 1.29 | 1.80 | — |
| `list-append/10` | loro | 100 | 4.15 | 4.45 | 3.91 | 4.55 | — |
| `edit+encode/10` | pulsify | 100 | 1.29 | 1.78 | 1.09 | 2.02 | 104.00 |
| `edit+encode/10` | json-joy | 100 | 2.59 | 3.60 | 2.26 | 3.99 | 58.79 |
| `edit+encode/10` | yjs-v2 | 100 | 4.64 | 5.28 | 4.38 | 5.37 | 33.44 |
| `edit+encode/10` | loro | 100 | 7.95 | 11.93 | 6.86 | 12.93 | 86.57 |
| `edit+encode/10` | yjs-v1 | 100 | 2.19 | 2.51 | 2.01 | 2.72 | 23.54 |
| `delta-roundtrip/10` | pulsify | 50 | 3.19 | 3.86 | 2.74 | 3.88 | 104.00 |
| `delta-roundtrip/10` | json-joy | 50 | 4.26 | 4.93 | 3.72 | 5.49 | 63.88 |
| `delta-roundtrip/10` | yjs-v2 | 50 | 7.45 | 8.44 | 6.88 | 8.54 | 32.94 |
| `delta-roundtrip/10` | loro | 50 | 15.03 | 16.97 | 13.91 | 22.00 | 86.00 |
| `delta-roundtrip/10` | yjs-v1 | 50 | 3.89 | 4.76 | 3.22 | 4.84 | 22.96 |
| `delta-roundtrip/1000` | pulsify | 5 | 10.28 | 12.02 | 9.12 | 12.71 | 104.00 |
| `delta-roundtrip/1000` | json-joy | 5 | 146.05 | 168.24 | 134.69 | 168.96 | 70.60 |
| `delta-roundtrip/1000` | yjs-v2 | 5 | 25.04 | 31.59 | 22.68 | 57.44 | 34.20 |
| `delta-roundtrip/1000` | loro | 5 | 44.33 | 54.81 | 38.77 | 63.42 | 88.00 |
| `delta-roundtrip/1000` | yjs-v1 | 5 | 20.23 | 22.83 | 17.72 | 22.98 | 25.20 |
| `initial-load+materialize/10` | pulsify | 10 | 13.80 | 16.77 | 11.20 | 18.44 | 284.00 |
| `initial-load+materialize/10` | json-joy | 10 | 14.05 | 16.96 | 11.24 | 17.15 | 439.00 |
| `initial-load+materialize/10` | yjs-v2 | 10 | 14.91 | 17.62 | 14.03 | 17.94 | 449.00 |
| `initial-load+materialize/10` | loro | 10 | 46.37 | 50.74 | 43.75 | 54.16 | 1030.00 |
| `initial-load+materialize/10` | yjs-v1 | 10 | 16.06 | 18.77 | 14.40 | 19.28 | 593.00 |
| `initial-load+materialize/1000` | pulsify | 2 | 364.29 | 406.73 | 341.19 | 411.44 | 17027.00 |
| `initial-load+materialize/1000` | json-joy | 2 | 648.17 | 687.48 | 617.65 | 700.77 | 36766.00 |
| `initial-load+materialize/1000` | yjs-v2 | 2 | 546.35 | 576.25 | 526.54 | 576.31 | 30012.00 |
| `initial-load+materialize/1000` | loro | 2 | 1617.35 | 1732.71 | 1592.00 | 1857.10 | 49733.00 |
| `initial-load+materialize/1000` | yjs-v1 | 2 | 644.42 | 678.23 | 619.96 | 697.44 | 47879.00 |
| `offline-merge/100-per-peer` | pulsify | 1 | 423.33 | 452.04 | 362.96 | 487.38 | 17334.00 |
| `offline-merge/100-per-peer` | json-joy | 1 | 85.71 | 106.92 | 61.13 | 111.38 | 139.00 |
| `offline-merge/100-per-peer` | yjs-v2 | 1 | 82.62 | 106.46 | 60.17 | 113.00 | 97.00 |
| `offline-merge/100-per-peer` | loro | 1 | 237.67 | 299.96 | 192.12 | 335.46 | 1624.00 |
| `offline-merge/100-per-peer` | yjs-v1 | 1 | 66.58 | 91.88 | 48.96 | 93.62 | 75.00 |
| `upstream-map-conflict/16-peers` | pulsify | 1 | 64.37 | 83.54 | 49.58 | 86.21 | 1728.00 |
| `upstream-map-conflict/16-peers` | json-joy | 1 | 62.67 | 79.92 | 49.83 | 82.83 | 1024.00 |
| `upstream-map-conflict/16-peers` | yjs-v2 | 1 | 90.46 | 116.13 | 76.88 | 159.75 | 512.00 |
| `upstream-map-conflict/16-peers` | loro | 1 | 396.12 | 464.00 | 355.37 | 473.08 | 1536.00 |
| `upstream-map-conflict/16-peers` | yjs-v1 | 1 | 78.87 | 96.00 | 62.25 | 98.79 | 336.00 |
| `proxy-overhead/read-count` | native-json-joy | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `proxy-overhead/read-count` | pulsify-direct | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `proxy-overhead/read-count` | pulsify-proxy | 10000 | 0.02 | 0.03 | 0.02 | 0.03 | — |
| `proxy-overhead/mutate-history-0` | native-json-joy | 200 | 0.29 | 0.31 | 0.26 | 0.33 | — |
| `proxy-overhead/mutate-history-0` | pulsify-direct | 200 | 0.23 | 0.28 | 0.20 | 0.30 | — |
| `proxy-overhead/mutate-history-0` | pulsify-proxy | 200 | 0.23 | 0.31 | 0.21 | 0.31 | — |
| `proxy-overhead/mutate-history-1000` | native-json-joy | 200 | 0.28 | 0.30 | 0.24 | 0.31 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-direct | 200 | 0.22 | 0.25 | 0.19 | 0.28 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-proxy | 200 | 0.24 | 0.31 | 0.21 | 0.33 | — |
| `proxy-overhead/mutate-history-5000` | native-json-joy | 200 | 0.25 | 0.27 | 0.24 | 0.27 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-direct | 200 | 0.23 | 0.29 | 0.18 | 0.31 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-proxy | 200 | 0.25 | 0.32 | 0.19 | 0.33 | — |
