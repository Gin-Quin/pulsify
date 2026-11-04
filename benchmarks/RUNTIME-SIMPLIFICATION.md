# Simplification du runtime : copies et parcours supprimés

Le chemin de réception applique chaque patch une seule fois au modèle actif, sans clone du modèle ni reconstruction de schéma à partir de la vue complète. La compatibilité et l'exclusivité des quatre métadonnées sont vérifiées à partir des opérations et des liens modifiés. Les migrations ne lisent et ne copient le document que si une migration est réellement nécessaire. Sans matérialiseur personnalisé, les snapshots copient directement la vue du moteur ; les matérialiseurs gardent leur comportement public.

Validation : 91 tests du cœur et 14 tests des adaptateurs, trois tests d'interop Rust, package strict NodeNext/Node, matrice Bun/Node/Deno/Chromium et scénario WebSocket à deux onglets avec reconnexion. La review indépendante a confirmé les corrections des références partagées et des timestamps de métadonnées ; huit tests runtime couvrent les refus atomiques et les snapshots.

Les deux suites complètes utilisent cinq échantillons d'échauffement puis 25 mesurés, soit 35 et 85 résultats. Les durées sont des médianes de moyennes par échantillon, en µs/op. Les paramètres, versions et charges utiles sont conservés.

Une première exécution présentait un ralentissement d'environ 2× des contrôles JSON/json-joy inchangés dans la suite protocole. Les deux suites ont été répétées après cette variation, et la dernière exécution complète est conservée ci-dessous. Les premiers JSON restent dans `benchmarks/results/*-runtime-first-run.json`. Deux mesures indépendantes ne donnent pas une attribution exacte de chaque microseconde ; les distributions complètes et les contrôles inchangés servent à apprécier le bruit.

json-joy natif exporte ici un delta structurel depuis son état ; Pulsify relit les opérations de son journal. Le coût des proxies est isolé séparément, avec le même pipeline Pulsify derrière les deux variantes.

## crdt-comparison

Avant : 2026-11-03T17:42:32.462Z. Après : 2026-11-03T21:23:52.153Z.

[JSON avant](baselines/crdt-comparison-before-runtime-simplification.json) · [JSON après](baselines/crdt-comparison-before-lazy-encoding.json)

| Cas | Avant µs/op | Après µs/op | Variation observée |
| --- | ---: | ---: | ---: | ---: |
| `crdt/delta-roundtrip/10/pulsify` | 19.34 | 7.49 | -61.3 % |
| `crdt/delta-roundtrip/1000/pulsify` | 1023.47 | 25.57 | -97.5 % |
| `crdt/initial-load+materialize/10/pulsify` | 57.41 | 36.51 | -36.4 % |
| `crdt/initial-load+materialize/1000/pulsify` | 3375.27 | 1840.42 | -45.5 % |
| `crdt/offline-merge/100-per-peer/pulsify` | 645.83 | 567.37 | -12.1 % |
| `crdt/upstream-map-conflict/16-peers/pulsify` | 356.50 | 137.46 | -61.4 % |
| `crdt/create/1000/pulsify` | 978.85 | 866.94 | -11.4 % |

## local-bun

Avant : 2026-11-03T17:42:18.541Z. Après : 2026-11-03T21:23:39.549Z.

[JSON avant](baselines/local-bun-before-runtime-simplification.json) · [JSON après](baselines/local-bun-before-lazy-encoding.json)

| Cas | Avant µs/op | Après µs/op | Variation observée |
| --- | ---: | ---: | ---: | ---: |
| `core/create/1000` | 1214.79 | 1013.06 | -16.6 % |
| `sync/update/one-way-0ms` | 37.18 | 24.71 | -33.5 % |
| `sync/initial-load/1000` | 2887.33 | 2368.77 | -18.0 % |
| `sync/reconnect/100-offline-edits` | 427.08 | 383.29 | -10.3 % |
| `json/encode/100` | 7.11 | 7.11 | -0.0 % |
| `json-joy/mutate` | 0.29 | 0.28 | -3.5 % |
