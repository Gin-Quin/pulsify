# Pulsify, json-joy, Yjs et Loro : comparaison locale

Ce fichier est généré par `bun run bench:crdt`. Les données brutes sont dans le JSON indiqué par `--output` (par défaut `benchmarks/results/crdt-comparison.json`). La référence complète conservée est [baselines/crdt-comparison.json](baselines/crdt-comparison.json).

**Conditions de mesure :** Machine partagée chargée : charge observée après exécution de 13,19 pour 10 cœurs logiques. Les distributions sont larges ; ces valeurs ne permettent pas de conclure à des ratios de vitesse précis ni de décider seules d’une régression.

## Environnement et protocole

- Apple M4, arm64, darwin 25.3.0, 10 cœurs.
- bun-1.4.4, codec 2.1.0, json-joy 18.28.0, Yjs 13.6.33, loro-crdt 1.17.1 (wasm-nodejs).
- 5 échantillons d'échauffement puis 25 mesurés ; 95 résultats. Mode court : false. Filtre : `aucun`.
- Ordre des participants mélangé à chaque bloc avec une graine fixe (5370206). GC forcé avant et après la préparation de chaque échantillon, hors chronométrage : les allocations temporaires de l'historique de préparation ne sont pas imputées à la mutation mesurée. Chaque échantillon utilise un état neuf.
- Les durées sont des **médianes de moyennes par échantillon**, en µs/op. Le p95 final porte lui aussi sur ces moyennes et ne représente pas la latence p95 de chaque événement individuel.
- Mesure UTC : 2026-11-04T01:23:08.285Z. Commit de base : `512aad7a420150ffb09a0f68e0b7f76d76352201`. Copie de travail modifiée : true.
- Codec encode et décode directement le schéma : aucun parcours supplémentaire de validation de schéma ni prélecture des octets dans Pulsify. Les limites de trame et les règles de cohérence du protocole sont conservées.

## Temps comparés

Les mêmes champs et valeurs sont utilisés : métadonnées de document, chaîne atomique, map imbriquée modifiable et liste de maps à deux champs. Les conteneurs imbriqués sont des CRDT dans les quatre implémentations, pas des objets JSON opaques. Les références du champ imbriqué sont mises en cache pour les lectures et mutations scalaires.

| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create/10` | 15.49 | 9.26 | 13.99 | 58.00 | — |
| `create+encode/10` | 30.16 | 14.40 | 25.31 | 149.99 | 21.67 |
| `create/1000` | 644.56 | 567.29 | 439.31 | 4476.77 | — |
| `create+encode/1000` | 951.23 | 760.54 | 527.90 | 4991.77 | 588.62 |
| `export-first/1000` | 431.58 | 298.96 | 208.04 | 1747.42 | 262.67 |
| `export-repeat/1000` | 45.54 | 348.33 | 258.63 | 139.17 | 316.13 |
| `read-count/10` | 0.10 | 0.01 | 0.01 | 0.13 | — |
| `mutate/history-0` | 1.70 | 0.38 | 1.22 | 1.32 | — |
| `mutate/history-1000` | 1.51 | 0.31 | 0.96 | 1.28 | — |
| `mutate/history-5000` | 1.49 | 0.30 | 0.93 | 1.26 | — |
| `list-append/10` | 9.70 | 1.12 | 1.55 | 4.44 | — |
| `edit+encode/10` | 4.29 | 3.48 | 6.77 | 14.92 | 3.15 |
| `delta-roundtrip/10` | 15.60 | 8.55 | 12.08 | 40.73 | 9.14 |
| `delta-roundtrip/1000` | 57.14 | 252.06 | 51.52 | 107.02 | 40.80 |
| `initial-load+materialize/10` | 59.85 | 28.70 | 26.01 | 75.73 | 27.37 |
| `initial-load+materialize/1000` | 3958.38 | 1224.00 | 1094.12 | 3018.77 | 1230.98 |
| `offline-merge/100-per-peer` | 1438.04 | 195.54 | 209.92 | 633.29 | 160.37 |
| `upstream-map-conflict/16-peers` | 217.87 | 104.08 | 144.50 | 544.50 | 115.96 |

## Taille des représentations transférées

Octets moyens par opération mesurée. Pour `offline-merge`, la valeur est la somme des deux deltas ; pour le conflit à 16 pairs, la somme des deltas importés par un seul récepteur. Ces octets sont des charges utiles, hors TCP/WebSocket/TLS.

| Scénario | Pulsify | json-joy natif | Yjs V2 | Loro WASM | Yjs V1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create+encode/10` | 1211.00 | 439.00 | 449.00 | 1030.00 | 593.00 |
| `create+encode/1000` | 92129.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `export-first/1000` | 92129.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `export-repeat/1000` | 92129.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `edit+encode/10` | 90.69 | 58.79 | 33.44 | 86.57 | 23.54 |
| `delta-roundtrip/10` | 89.38 | 63.88 | 32.94 | 86.00 | 22.96 |
| `delta-roundtrip/1000` | 92.00 | 70.60 | 34.20 | 88.00 | 25.20 |
| `initial-load+materialize/10` | 1211.00 | 439.00 | 449.00 | 1030.00 | 593.00 |
| `initial-load+materialize/1000` | 92129.00 | 36766.00 | 30012.00 | 49733.00 | 47879.00 |
| `offline-merge/100-per-peer` | 14538.00 | 139.00 | 97.00 | 1624.00 | 75.00 |
| `upstream-map-conflict/16-peers` | 1472.00 | 1024.00 | 512.00 | 1536.00 | 336.00 |

Les représentations ne retiennent pas toutes le même historique : Pulsify transmet son journal de segments dans des messages validés avec identifiant et vecteurs ; json-joy natif utilise ses snapshots structurels et deltas ; Yjs utilise son état avec le GC activé par défaut ; Loro utilise un snapshot avec historique, puis des updates. Aucun snapshot superficiel Loro ni stockage supplémentaire pour restaurer les anciennes versions Yjs n'est ajouté.

## Isolation du coût des proxies

Le pipeline « sans proxy » utilise la même instance Pulsify et le même chemin de commit et de journal natif que le proxy public, mais appelle directement le builder pour le champ scalaire. Aucun encodage n'est effectué dans ces écritures locales. Un test exporte ensuite les deux historiques et vérifie **exactement les mêmes octets**. La différence avec json-joy natif comprend les autres services de Pulsify et son chemin de mutation, pas seulement les proxies.

| Scénario | json-joy natif | Pipeline Pulsify sans proxy | Pulsify avec proxy | Écart proxy − pipeline |
| --- | ---: | ---: | ---: | ---: |
| `proxy-overhead/read-count` | 0.01 | 0.01 | 0.13 | 0.12 |
| `proxy-overhead/mutate-history-0` | 0.43 | 1.69 | 1.79 | 0.10 |
| `proxy-overhead/mutate-history-1000` | 0.35 | 1.67 | 1.58 | -0.10 |
| `proxy-overhead/mutate-history-5000` | 0.31 | 1.40 | 1.57 | 0.16 |

Les écarts sont des différences de médianes observées, pas un profil instruction par instruction. Un petit écart ou un écart négatif peut être du bruit ou une différence d'optimisation JIT. La création et l'encodage du journal ne doivent donc pas être attribués intégralement aux proxies.

L'écart public − direct inclut aussi les contrôles et conversions du setter public. Il ne mesure pas seulement les instructions des traps JavaScript.

Sur la mutation scalaire sans historique préparé, la surcouche complète coûte 4.18 fois le temps de json-joy natif. L'écart proxy − pipeline est de 0.10 µs, soit 5.83 % du pipeline sans proxy. Le pipeline sans proxy coûte déjà 3.95 fois le temps natif : les traps du proxy expliquent une petite partie du surcoût de cette écriture. Cette décomposition concerne le champ scalaire mis en cache, pas toutes les opérations de listes ou la création des vues.

L'import applique chaque patch une seule fois, sans cloner le modèle ni parcourir la vue complète. La compatibilité est vérifiée sur les quatre métadonnées de racine, seulement lorsqu'elles changent. Les migrations ne lisent et ne copient la vue que si une migration est réellement nécessaire ([PulseRuntime.ts](../packages/pulse/source/pulses/PulseRuntime.ts)). Un snapshot sans matérialiseur personnalisé copie directement la vue du moteur ; un matérialiseur conserve son parcours public. La taille élevée après 100 éditions hors ligne reflète la conservation de chaque segment, tandis que les formats structurels peuvent condenser les valeurs écrasées.

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
- Le texte caractère par caractère, les déplacements natifs de `MovableList`, les arbres et le voyage dans le temps ne sont pas comparés : Pulsify ne propose pas ces mêmes API.
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
| `create/10` | pulsify | 20 | 15.49 | 20.09 | 10.34 | 22.87 | — |
| `create/10` | json-joy | 20 | 9.26 | 13.98 | 6.78 | 14.13 | — |
| `create/10` | yjs-v2 | 20 | 13.99 | 21.88 | 9.86 | 23.16 | — |
| `create/10` | loro | 20 | 58.00 | 97.94 | 46.46 | 112.46 | — |
| `create+encode/10` | pulsify | 20 | 30.16 | 56.67 | 18.83 | 66.74 | 1211.00 |
| `create+encode/10` | json-joy | 20 | 14.40 | 27.22 | 11.03 | 34.10 | 439.00 |
| `create+encode/10` | yjs-v2 | 20 | 25.31 | 52.65 | 17.88 | 55.40 | 449.00 |
| `create+encode/10` | loro | 20 | 149.99 | 267.96 | 90.56 | 346.15 | 1030.00 |
| `create+encode/10` | yjs-v1 | 20 | 21.67 | 45.77 | 14.64 | 62.13 | 593.00 |
| `create/1000` | pulsify | 2 | 644.56 | 1283.19 | 477.27 | 1348.12 | — |
| `create/1000` | json-joy | 2 | 567.29 | 1099.17 | 458.08 | 1170.77 | — |
| `create/1000` | yjs-v2 | 2 | 439.31 | 1074.04 | 325.90 | 1248.94 | — |
| `create/1000` | loro | 2 | 4476.77 | 5979.33 | 3063.50 | 6707.63 | — |
| `create+encode/1000` | pulsify | 2 | 951.23 | 1784.65 | 872.44 | 1793.37 | 92129.00 |
| `create+encode/1000` | json-joy | 2 | 760.54 | 1364.65 | 719.77 | 2014.04 | 36766.00 |
| `create+encode/1000` | yjs-v2 | 2 | 527.90 | 826.85 | 486.35 | 1345.19 | 30012.00 |
| `create+encode/1000` | loro | 2 | 4991.77 | 8633.15 | 4725.63 | 9365.58 | 49733.00 |
| `create+encode/1000` | yjs-v1 | 2 | 588.62 | 1068.96 | 546.37 | 1271.12 | 47879.00 |
| `export-first/1000` | pulsify | 1 | 431.58 | 542.12 | 401.37 | 1176.29 | 92129.00 |
| `export-first/1000` | json-joy | 1 | 298.96 | 392.08 | 275.79 | 417.29 | 36766.00 |
| `export-first/1000` | yjs-v2 | 1 | 208.04 | 739.83 | 188.46 | 772.29 | 30012.00 |
| `export-first/1000` | loro | 1 | 1747.42 | 2958.50 | 1679.83 | 3208.71 | 49733.00 |
| `export-first/1000` | yjs-v1 | 1 | 262.67 | 375.67 | 238.83 | 864.67 | 47879.00 |
| `export-repeat/1000` | pulsify | 1 | 45.54 | 110.67 | 22.29 | 3702.21 | 92129.00 |
| `export-repeat/1000` | json-joy | 1 | 348.33 | 765.79 | 273.25 | 847.50 | 36766.00 |
| `export-repeat/1000` | yjs-v2 | 1 | 258.63 | 721.33 | 195.33 | 799.54 | 30012.00 |
| `export-repeat/1000` | loro | 1 | 139.17 | 229.17 | 84.29 | 235.04 | 49733.00 |
| `export-repeat/1000` | yjs-v1 | 1 | 316.13 | 960.42 | 233.88 | 1108.21 | 47879.00 |
| `read-count/10` | pulsify | 10000 | 0.10 | 0.11 | 0.09 | 0.12 | — |
| `read-count/10` | json-joy | 10000 | 0.01 | 0.01 | 0.01 | 0.01 | — |
| `read-count/10` | yjs-v2 | 10000 | 0.01 | 0.01 | 0.01 | 0.02 | — |
| `read-count/10` | loro | 10000 | 0.13 | 0.14 | 0.12 | 0.15 | — |
| `mutate/history-0` | pulsify | 200 | 1.70 | 2.07 | 1.53 | 2.14 | — |
| `mutate/history-0` | json-joy | 200 | 0.38 | 0.57 | 0.34 | 0.95 | — |
| `mutate/history-0` | yjs-v2 | 200 | 1.22 | 1.66 | 0.99 | 2.53 | — |
| `mutate/history-0` | loro | 200 | 1.32 | 1.51 | 1.26 | 2.03 | — |
| `mutate/history-1000` | pulsify | 200 | 1.51 | 1.95 | 1.29 | 2.10 | — |
| `mutate/history-1000` | json-joy | 200 | 0.31 | 0.36 | 0.26 | 0.42 | — |
| `mutate/history-1000` | yjs-v2 | 200 | 0.96 | 1.67 | 0.84 | 2.15 | — |
| `mutate/history-1000` | loro | 200 | 1.28 | 1.75 | 1.22 | 1.80 | — |
| `mutate/history-5000` | pulsify | 200 | 1.49 | 1.67 | 1.37 | 1.75 | — |
| `mutate/history-5000` | json-joy | 200 | 0.30 | 0.57 | 0.26 | 0.64 | — |
| `mutate/history-5000` | yjs-v2 | 200 | 0.93 | 1.07 | 0.86 | 1.12 | — |
| `mutate/history-5000` | loro | 200 | 1.26 | 1.34 | 1.18 | 1.42 | — |
| `list-append/10` | pulsify | 100 | 9.70 | 11.15 | 9.25 | 12.70 | — |
| `list-append/10` | json-joy | 100 | 1.12 | 1.30 | 0.98 | 1.37 | — |
| `list-append/10` | yjs-v2 | 100 | 1.55 | 1.89 | 1.40 | 1.98 | — |
| `list-append/10` | loro | 100 | 4.44 | 4.96 | 4.15 | 12.67 | — |
| `edit+encode/10` | pulsify | 100 | 4.29 | 15.58 | 3.37 | 18.88 | 90.69 |
| `edit+encode/10` | json-joy | 100 | 3.48 | 7.98 | 2.81 | 8.22 | 58.79 |
| `edit+encode/10` | yjs-v2 | 100 | 6.77 | 15.89 | 5.11 | 17.48 | 33.44 |
| `edit+encode/10` | loro | 100 | 14.92 | 29.27 | 8.68 | 30.23 | 86.57 |
| `edit+encode/10` | yjs-v1 | 100 | 3.15 | 7.48 | 2.31 | 7.62 | 23.54 |
| `delta-roundtrip/10` | pulsify | 50 | 15.60 | 38.89 | 10.73 | 41.00 | 89.38 |
| `delta-roundtrip/10` | json-joy | 50 | 8.55 | 16.05 | 5.12 | 16.37 | 63.88 |
| `delta-roundtrip/10` | yjs-v2 | 50 | 12.08 | 26.72 | 9.74 | 27.01 | 32.94 |
| `delta-roundtrip/10` | loro | 50 | 40.73 | 62.98 | 20.85 | 77.49 | 86.00 |
| `delta-roundtrip/10` | yjs-v1 | 50 | 9.14 | 19.29 | 5.15 | 20.21 | 22.96 |
| `delta-roundtrip/1000` | pulsify | 5 | 57.14 | 106.33 | 36.45 | 287.38 | 92.00 |
| `delta-roundtrip/1000` | json-joy | 5 | 252.06 | 395.36 | 176.59 | 506.85 | 70.60 |
| `delta-roundtrip/1000` | yjs-v2 | 5 | 51.52 | 113.87 | 39.79 | 136.99 | 34.20 |
| `delta-roundtrip/1000` | loro | 5 | 107.02 | 350.56 | 72.41 | 439.76 | 88.00 |
| `delta-roundtrip/1000` | yjs-v1 | 5 | 40.80 | 99.21 | 30.76 | 101.46 | 25.20 |
| `initial-load+materialize/10` | pulsify | 10 | 59.85 | 146.02 | 42.78 | 153.71 | 1211.00 |
| `initial-load+materialize/10` | json-joy | 10 | 28.70 | 55.41 | 19.85 | 97.72 | 439.00 |
| `initial-load+materialize/10` | yjs-v2 | 10 | 26.01 | 51.84 | 20.38 | 57.63 | 449.00 |
| `initial-load+materialize/10` | loro | 10 | 75.73 | 158.56 | 63.41 | 162.45 | 1030.00 |
| `initial-load+materialize/10` | yjs-v1 | 10 | 27.37 | 56.86 | 22.60 | 78.48 | 593.00 |
| `initial-load+materialize/1000` | pulsify | 2 | 3958.38 | 5546.69 | 2746.94 | 5577.06 | 92129.00 |
| `initial-load+materialize/1000` | json-joy | 2 | 1224.00 | 2020.52 | 785.83 | 3432.10 | 36766.00 |
| `initial-load+materialize/1000` | yjs-v2 | 2 | 1094.12 | 1810.52 | 592.27 | 2066.56 | 30012.00 |
| `initial-load+materialize/1000` | loro | 2 | 3018.77 | 3915.87 | 2087.54 | 3973.88 | 49733.00 |
| `initial-load+materialize/1000` | yjs-v1 | 2 | 1230.98 | 2024.50 | 819.40 | 2181.73 | 47879.00 |
| `offline-merge/100-per-peer` | pulsify | 1 | 1438.04 | 2646.29 | 874.63 | 2729.67 | 14538.00 |
| `offline-merge/100-per-peer` | json-joy | 1 | 195.54 | 314.50 | 139.04 | 382.62 | 139.00 |
| `offline-merge/100-per-peer` | yjs-v2 | 1 | 209.92 | 340.08 | 131.12 | 356.33 | 97.00 |
| `offline-merge/100-per-peer` | loro | 1 | 633.29 | 896.12 | 388.21 | 1507.54 | 1624.00 |
| `offline-merge/100-per-peer` | yjs-v1 | 1 | 160.37 | 371.96 | 103.29 | 526.50 | 75.00 |
| `upstream-map-conflict/16-peers` | pulsify | 1 | 217.87 | 410.88 | 142.58 | 514.37 | 1472.00 |
| `upstream-map-conflict/16-peers` | json-joy | 1 | 104.08 | 144.96 | 61.38 | 233.42 | 1024.00 |
| `upstream-map-conflict/16-peers` | yjs-v2 | 1 | 144.50 | 357.92 | 87.25 | 412.46 | 512.00 |
| `upstream-map-conflict/16-peers` | loro | 1 | 544.50 | 1187.00 | 425.67 | 1431.88 | 1536.00 |
| `upstream-map-conflict/16-peers` | yjs-v1 | 1 | 115.96 | 264.50 | 76.67 | 325.79 | 336.00 |
| `proxy-overhead/read-count` | native-json-joy | 10000 | 0.01 | 0.02 | 0.01 | 0.03 | — |
| `proxy-overhead/read-count` | pulsify-direct | 10000 | 0.01 | 0.03 | 0.01 | 0.04 | — |
| `proxy-overhead/read-count` | pulsify-proxy | 10000 | 0.13 | 0.28 | 0.11 | 0.31 | — |
| `proxy-overhead/mutate-history-0` | native-json-joy | 200 | 0.43 | 0.90 | 0.30 | 1.18 | — |
| `proxy-overhead/mutate-history-0` | pulsify-direct | 200 | 1.69 | 3.90 | 1.29 | 3.97 | — |
| `proxy-overhead/mutate-history-0` | pulsify-proxy | 200 | 1.79 | 4.56 | 1.35 | 5.33 | — |
| `proxy-overhead/mutate-history-1000` | native-json-joy | 200 | 0.35 | 0.76 | 0.29 | 0.84 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-direct | 200 | 1.67 | 3.96 | 1.20 | 5.15 | — |
| `proxy-overhead/mutate-history-1000` | pulsify-proxy | 200 | 1.58 | 4.50 | 1.34 | 4.99 | — |
| `proxy-overhead/mutate-history-5000` | native-json-joy | 200 | 0.31 | 0.64 | 0.26 | 0.70 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-direct | 200 | 1.40 | 2.15 | 1.25 | 3.45 | — |
| `proxy-overhead/mutate-history-5000` | pulsify-proxy | 200 | 1.57 | 2.81 | 1.33 | 3.06 | — |
