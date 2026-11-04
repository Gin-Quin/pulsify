# Pulsify, json-joy, Yjs et Loro : comparaison locale

Ce fichier est généré par `bun run bench:crdt`. Les données brutes sont dans le JSON indiqué par `--output` (par défaut `benchmarks/results/crdt-comparison.json`). La référence complète conservée est [baselines/core-grouped-20261104.json](baselines/core-grouped-20261104.json).



## Environnement et protocole

- Apple M4, arm64, darwin 25.3.0, 10 cœurs.
- bun-1.4.4, codec 2.1.0, json-joy 18.28.0, Yjs 13.6.33, loro-crdt 1.17.1 (wasm-nodejs).
- 5 échantillons d'échauffement puis 25 mesurés ; 95 résultats. Mode court : false. Filtre : `aucun`.
- Ordre des participants mélangé à chaque bloc avec une graine fixe (5370206). GC forcé avant et après la préparation de chaque échantillon, hors chronométrage : les allocations temporaires de l'historique de préparation ne sont pas imputées à la mutation mesurée. Chaque échantillon utilise un état neuf.
- Les durées sont des **médianes de moyennes par échantillon**, en µs/op. Le p95 final porte lui aussi sur ces moyennes et ne représente pas la latence p95 de chaque événement individuel.
- Mesure UTC : 2026-11-04T14:58:59.812Z. Commit de base : `876fb3d7453faf70315eef72d2b98ca8e49e4e04`. Copie de travail modifiée : false.
- Moteur Pulsify : native-core-v2-grouped. Schéma fourni explicitement : codec object: title string, nested count float64, items editable array of { value float64, label string }. Sa compilation et la définition sont préparées hors chronométrage ; les données et conteneurs éditables restent ceux de la suite initiale.
- Les schémas applicatifs compilent leurs codecs, copies et contrôles de valeurs. Pulsify exécute les contrôles des champs affectés avant leur commit ou application. Le décodage de l'enveloppe utilise codec directement, sans second parcours récursif de son schéma. Les limites de trame, références causales et règles de cohérence sont conservées.

## Temps comparés

Les mêmes champs et valeurs sont utilisés : métadonnées de document, chaîne atomique, map imbriquée modifiable et liste de maps à deux champs. Les conteneurs imbriqués sont des CRDT dans les quatre implémentations, pas des objets JSON opaques. Les références du champ imbriqué sont mises en cache pour les lectures et mutations scalaires.

| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create/10` | 9.44 | 11.09 | 13.59 | 52.96 | — |
| `create+encode/10` | 11.99 | 12.35 | 18.83 | 99.24 | 16.04 |
| `create/1000` | 273.90 | 475.46 | 335.52 | 3133.13 | — |
| `create+encode/1000` | 326.15 | 727.04 | 501.25 | 4807.71 | 558.75 |
| `export-first/1000` | 62.17 | 289.25 | 201.12 | 1729.58 | 248.58 |
| `export-repeat/1000` | 23.62 | 288.58 | 205.08 | 95.79 | 256.42 |
| `read-count/10` | 0.02 | 0.01 | 0.01 | 0.13 | — |
| `mutate/history-0` | 0.20 | 0.39 | 1.19 | 1.32 | — |
| `mutate/history-1000` | 0.16 | 0.28 | 0.92 | 1.29 | — |
| `mutate/history-5000` | 0.14 | 0.28 | 0.94 | 1.27 | — |
| `list-append/10` | 1.15 | 1.09 | 1.62 | 4.45 | — |
| `edit+encode/10` | 1.48 | 2.71 | 4.91 | 8.52 | 2.28 |
| `delta-roundtrip/10` | 3.34 | 4.55 | 8.23 | 16.80 | 4.24 |
| `delta-roundtrip/1000` | 12.29 | 159.89 | 30.73 | 50.75 | 25.43 |
| `initial-load+materialize/10` | 15.87 | 16.05 | 17.24 | 50.33 | 17.98 |
| `initial-load+materialize/1000` | 395.67 | 700.27 | 578.56 | 1701.50 | 669.67 |
| `offline-merge/100-per-peer` | 178.12 | 93.92 | 91.46 | 264.21 | 75.04 |
| `upstream-map-conflict/16-peers` | 61.92 | 71.50 | 102.04 | 396.12 | 89.92 |

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
| `offline-merge/100-per-peer` | 2246.00 | 139.00 | 97.00 | 1624.00 | 75.00 |
| `upstream-map-conflict/16-peers` | 1728.00 | 1024.00 | 512.00 | 1536.00 | 336.00 |

Les représentations ne retiennent pas toutes le même historique : Pulsify transmet son journal de segments dans des messages validés avec identifiant et vecteurs ; json-joy natif utilise ses snapshots structurels et deltas ; Yjs utilise son état avec le GC activé par défaut ; Loro utilise un snapshot avec historique, puis des updates. Aucun snapshot superficiel Loro ni stockage supplémentaire pour restaurer les anciennes versions Yjs n'est ajouté.

## Isolation du coût des proxies

Le pipeline « sans proxy » utilise la même instance Pulsify et le même chemin de commit et de journal que le proxy public, mais appelle directement `CoreModel.set` pour le champ scalaire. Aucun encodage n'est effectué dans ces écritures locales. Un test exporte ensuite les deux historiques et vérifie **exactement les mêmes octets**. La différence avec json-joy natif comprend les autres services de Pulsify et son chemin de mutation, pas seulement les proxies.

| Scénario | json-joy natif | Pipeline Pulsify sans proxy | Pulsify avec proxy | Écart proxy − pipeline |
| --- | ---: | ---: | ---: | ---: |
| `proxy-overhead/read-count` | 0.01 | 0.01 | 0.02 | 0.01 |
| `proxy-overhead/mutate-history-0` | 0.32 | 0.18 | 0.20 | 0.02 |
| `proxy-overhead/mutate-history-1000` | 0.30 | 0.15 | 0.15 | 0.00 |
| `proxy-overhead/mutate-history-5000` | 0.28 | 0.15 | 0.15 | 0.00 |

Les écarts sont des différences de médianes observées, pas un profil instruction par instruction. Un petit écart ou un écart négatif peut être du bruit ou une différence d'optimisation JIT. La création et l'encodage du journal ne doivent donc pas être attribués intégralement aux proxies.

L'écart public − direct inclut aussi les contrôles et conversions du setter public. Il ne mesure pas seulement les instructions des traps JavaScript.

Sur la mutation scalaire sans historique préparé, l’API publique Pulsify prend 0.63 fois le temps de json-joy natif. L'écart proxy − pipeline est de 0.02 µs, soit 8.80 % du pipeline sans proxy. Le moteur Pulsify sans proxy prend 0.58 fois le temps natif : ce scénario distingue le coût du chemin public et celui de la mutation interne. Cette décomposition concerne le champ scalaire mis en cache, pas toutes les opérations de listes ou la création des vues.

Pulsify utilise son propre moteur : registres LWW pour les champs et RGA pour les listes. Aucun moteur json-joy ou Yjs ne se trouve dans son chemin d’exécution. L’import prévalide les références et modifications puis applique chaque patch, sans cloner le document entier. Les métadonnées de racine sont vérifiées lors de leur création ou modification. Les migrations ne lisent et ne copient la vue que si une migration est réellement nécessaire ([PulseRuntime.ts](../packages/pulse/source/pulses/PulseRuntime.ts)). Sans matérialiseur personnalisé, le snapshot utilise une copie spécialisée du schéma lorsque la forme de la vue le permet et conserve une copie générale sinon. Un matérialiseur conserve son parcours public. Le journal conserve chaque transaction, tandis que les formats structurels peuvent condenser les valeurs écrasées. Le transport groupé, lorsqu’il est négocié, partage les en-têtes scalaires sans supprimer les opérations.

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
| `create/10` | pulsify | 20 | 9.44 | 16.82 | 7.63 | 16.96 | — |
| `create/10` | json-joy | 20 | 11.09 | 17.41 | 9.02 | 19.16 | — |
| `create/10` | yjs-v2 | 20 | 13.59 | 19.31 | 11.32 | 22.70 | — |
| `create/10` | loro | 20 | 52.96 | 121.53 | 47.93 | 122.56 | — |
| `create+encode/10` | pulsify | 20 | 11.99 | 17.82 | 9.98 | 18.25 | 284.00 |
| `create+encode/10` | json-joy | 20 | 12.35 | 17.25 | 10.57 | 22.40 | 439.00 |
| `create+encode/10` | yjs-v2 | 20 | 18.83 | 25.69 | 15.37 | 26.46 | 449.00 |
| `create+encode/10` | loro | 20 | 99.24 | 141.79 | 84.66 | 161.45 | 1030.00 |
| `create+encode/10` | yjs-v1 | 20 | 16.04 | 19.19 | 13.60 | 20.59 | 593.00 |
| `create/1000` | pulsify | 2 | 273.90 | 302.40 | 262.10 | 332.81 | — |
| `create/1000` | json-joy | 2 | 475.46 | 680.71 | 451.90 | 772.50 | — |
| `create/1000` | yjs-v2 | 2 | 335.52 | 365.69 | 318.67 | 369.81 | — |
| `create/1000` | loro | 2 | 3133.13 | 3336.19 | 3058.98 | 4032.71 | — |
| `create+encode/1000` | pulsify | 2 | 326.15 | 414.21 | 297.31 | 438.31 | 17027.00 |
| `create+encode/1000` | json-joy | 2 | 727.04 | 1065.21 | 698.10 | 2688.67 | 36766.00 |
| `create+encode/1000` | yjs-v2 | 2 | 501.25 | 547.23 | 465.37 | 596.77 | 30012.00 |
| `create+encode/1000` | loro | 2 | 4807.71 | 4970.12 | 4687.79 | 17087.88 | 49733.00 |
| `create+encode/1000` | yjs-v1 | 2 | 558.75 | 621.40 | 534.71 | 623.31 | 47879.00 |
| `export-first/1000` | pulsify | 1 | 62.17 | 80.58 | 53.54 | 85.96 | 17027.00 |
| `export-first/1000` | json-joy | 1 | 289.25 | 327.00 | 272.50 | 370.67 | 36766.00 |
| `export-first/1000` | yjs-v2 | 1 | 201.12 | 247.92 | 189.50 | 310.96 | 30012.00 |
| `export-first/1000` | loro | 1 | 1729.58 | 1775.79 | 1683.92 | 1870.79 | 49733.00 |
| `export-first/1000` | yjs-v1 | 1 | 248.58 | 276.25 | 234.71 | 283.67 | 47879.00 |
| `export-repeat/1000` | pulsify | 1 | 23.62 | 38.08 | 16.00 | 40.25 | 17027.00 |
| `export-repeat/1000` | json-joy | 1 | 288.58 | 326.08 | 270.00 | 360.75 | 36766.00 |
| `export-repeat/1000` | yjs-v2 | 1 | 205.08 | 252.00 | 179.67 | 594.96 | 30012.00 |
| `export-repeat/1000` | loro | 1 | 95.79 | 123.29 | 72.54 | 123.67 | 49733.00 |
| `export-repeat/1000` | yjs-v1 | 1 | 256.42 | 371.33 | 235.08 | 607.33 | 47879.00 |
| `read-count/10` | pulsify | 10000 | 0.02 | 0.03 | 0.02 | 0.07 | — |
| `read-count/10` | json-joy | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `read-count/10` | yjs-v2 | 10000 | 0.01 | 0.02 | 0.01 | 0.02 | — |
| `read-count/10` | loro | 10000 | 0.13 | 0.14 | 0.13 | 0.20 | — |
| `mutate/history-0` | pulsify | 200 | 0.20 | 0.23 | 0.19 | 0.23 | — |
| `mutate/history-0` | json-joy | 200 | 0.39 | 0.45 | 0.36 | 0.46 | — |
| `mutate/history-0` | yjs-v2 | 200 | 1.19 | 1.48 | 1.04 | 2.83 | — |
| `mutate/history-0` | loro | 200 | 1.32 | 1.95 | 1.26 | 2.94 | — |
| `mutate/history-1000` | pulsify | 200 | 0.16 | 0.21 | 0.12 | 0.21 | — |
| `mutate/history-1000` | json-joy | 200 | 0.28 | 0.37 | 0.25 | 0.40 | — |
| `mutate/history-1000` | yjs-v2 | 200 | 0.92 | 1.08 | 0.85 | 1.11 | — |
| `mutate/history-1000` | loro | 200 | 1.29 | 1.32 | 1.22 | 1.32 | — |
| `mutate/history-5000` | pulsify | 200 | 0.14 | 0.16 | 0.12 | 0.17 | — |
| `mutate/history-5000` | json-joy | 200 | 0.28 | 0.33 | 0.25 | 0.36 | — |
| `mutate/history-5000` | yjs-v2 | 200 | 0.94 | 1.02 | 0.87 | 1.02 | — |
| `mutate/history-5000` | loro | 200 | 1.27 | 1.32 | 1.22 | 1.38 | — |
| `list-append/10` | pulsify | 100 | 1.15 | 1.72 | 0.97 | 1.99 | — |
| `list-append/10` | json-joy | 100 | 1.09 | 1.46 | 0.96 | 1.50 | — |
| `list-append/10` | yjs-v2 | 100 | 1.62 | 1.78 | 1.42 | 1.89 | — |
| `list-append/10` | loro | 100 | 4.45 | 4.70 | 4.29 | 7.85 | — |
| `edit+encode/10` | pulsify | 100 | 1.48 | 2.11 | 1.21 | 2.31 | 104.00 |
| `edit+encode/10` | json-joy | 100 | 2.71 | 3.50 | 2.35 | 3.67 | 58.79 |
| `edit+encode/10` | yjs-v2 | 100 | 4.91 | 5.65 | 4.57 | 5.80 | 33.44 |
| `edit+encode/10` | loro | 100 | 8.52 | 14.29 | 7.73 | 27.39 | 86.57 |
| `edit+encode/10` | yjs-v1 | 100 | 2.28 | 2.92 | 2.16 | 2.96 | 23.54 |
| `delta-roundtrip/10` | pulsify | 50 | 3.34 | 4.03 | 2.95 | 4.24 | 104.00 |
| `delta-roundtrip/10` | json-joy | 50 | 4.55 | 5.54 | 4.19 | 5.57 | 63.88 |
| `delta-roundtrip/10` | yjs-v2 | 50 | 8.23 | 9.76 | 7.63 | 9.83 | 32.94 |
| `delta-roundtrip/10` | loro | 50 | 16.80 | 18.34 | 15.06 | 19.91 | 86.00 |
| `delta-roundtrip/10` | yjs-v1 | 50 | 4.24 | 5.27 | 3.69 | 5.68 | 22.96 |
| `delta-roundtrip/1000` | pulsify | 5 | 12.29 | 14.92 | 10.00 | 16.88 | 104.00 |
| `delta-roundtrip/1000` | json-joy | 5 | 159.89 | 175.73 | 151.32 | 176.01 | 70.60 |
| `delta-roundtrip/1000` | yjs-v2 | 5 | 30.73 | 43.23 | 24.04 | 49.14 | 34.20 |
| `delta-roundtrip/1000` | loro | 5 | 50.75 | 62.36 | 46.16 | 65.47 | 88.00 |
| `delta-roundtrip/1000` | yjs-v1 | 5 | 25.43 | 32.42 | 20.62 | 35.67 | 25.20 |
| `initial-load+materialize/10` | pulsify | 10 | 15.87 | 19.02 | 13.81 | 21.01 | 284.00 |
| `initial-load+materialize/10` | json-joy | 10 | 16.05 | 18.59 | 12.83 | 18.76 | 439.00 |
| `initial-load+materialize/10` | yjs-v2 | 10 | 17.24 | 19.74 | 15.38 | 19.81 | 449.00 |
| `initial-load+materialize/10` | loro | 10 | 50.33 | 54.60 | 47.42 | 57.75 | 1030.00 |
| `initial-load+materialize/10` | yjs-v1 | 10 | 17.98 | 20.60 | 16.25 | 20.71 | 593.00 |
| `initial-load+materialize/1000` | pulsify | 2 | 395.67 | 437.52 | 369.58 | 448.10 | 17027.00 |
| `initial-load+materialize/1000` | json-joy | 2 | 700.27 | 785.10 | 665.77 | 786.60 | 36766.00 |
| `initial-load+materialize/1000` | yjs-v2 | 2 | 578.56 | 642.44 | 549.04 | 656.08 | 30012.00 |
| `initial-load+materialize/1000` | loro | 2 | 1701.50 | 1922.88 | 1652.46 | 1923.73 | 49733.00 |
| `initial-load+materialize/1000` | yjs-v1 | 2 | 669.67 | 719.46 | 638.10 | 726.52 | 47879.00 |
| `offline-merge/100-per-peer` | pulsify | 1 | 178.12 | 222.13 | 139.96 | 234.42 | 2246.00 |
| `offline-merge/100-per-peer` | json-joy | 1 | 93.92 | 113.21 | 82.33 | 158.75 | 139.00 |
| `offline-merge/100-per-peer` | yjs-v2 | 1 | 91.46 | 109.83 | 77.62 | 120.42 | 97.00 |
| `offline-merge/100-per-peer` | loro | 1 | 264.21 | 315.71 | 230.96 | 384.25 | 1624.00 |
| `offline-merge/100-per-peer` | yjs-v1 | 1 | 75.04 | 96.54 | 58.92 | 100.21 | 75.00 |
| `upstream-map-conflict/16-peers` | pulsify | 1 | 61.92 | 119.67 | 44.58 | 362.29 | 1728.00 |
| `upstream-map-conflict/16-peers` | json-joy | 1 | 71.50 | 98.67 | 60.46 | 103.25 | 1024.00 |
| `upstream-map-conflict/16-peers` | yjs-v2 | 1 | 102.04 | 163.58 | 80.54 | 169.50 | 512.00 |
| `upstream-map-conflict/16-peers` | loro | 1 | 396.12 | 503.00 | 363.62 | 521.08 | 1536.00 |
| `upstream-map-conflict/16-peers` | yjs-v1 | 1 | 89.92 | 118.67 | 62.25 | 118.83 | 336.00 |
| `proxy-overhead/read-count` | native-json-joy | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `proxy-overhead/read-count` | pulsify-direct | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `proxy-overhead/read-count` | pulsify-proxy | 10000 | 0.02 | 0.03 | 0.02 | 0.03 | — |
| `proxy-overhead/mutate-history-0` | native-json-joy | 200 | 0.32 | 0.34 | 0.30 | 0.34 | — |
| `proxy-overhead/mutate-history-0` | pulsify-direct | 200 | 0.18 | 0.23 | 0.16 | 0.29 | — |
| `proxy-overhead/mutate-history-0` | pulsify-proxy | 200 | 0.20 | 0.26 | 0.18 | 0.28 | — |
| `proxy-overhead/mutate-history-1000` | native-json-joy | 200 | 0.30 | 0.33 | 0.26 | 0.34 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-direct | 200 | 0.15 | 0.16 | 0.12 | 0.17 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-proxy | 200 | 0.15 | 0.18 | 0.14 | 0.21 | — |
| `proxy-overhead/mutate-history-5000` | native-json-joy | 200 | 0.28 | 0.33 | 0.25 | 0.37 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-direct | 200 | 0.15 | 0.17 | 0.13 | 0.17 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-proxy | 200 | 0.15 | 0.18 | 0.13 | 0.25 | — |
