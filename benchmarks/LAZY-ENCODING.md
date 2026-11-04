# Encodage différé : création locale et sortie binaire séparées

La création et les modifications locales enregistrent les patches natifs, sans conversion portable, encodage binaire ni copie d'octets. Le proxy racine et le registre d'identité restent en place. Une connexion explicite ou `{ connect: true }` demande les lignes à transmettre ; un export les demande également. Chaque patch demandé est encodé une fois, puis son getter est remplacé par ses octets en cache, libérant la fermeture qui retenait le patch natif.

Les sorties possèdent leurs copies de métadonnées et d'octets. Les lignes causales en attente sont encore libérées correctement par un commit local. Les quotas de lignes/métadonnées sont vérifiés au commit local ; les limites binaires le sont à l'envoi/export. Un patch local trop grand peut rester utilisable localement et échouer à l'export. Une insertion rejetée ne consomme pas le quota de son cache, même si une référence conservée est lue plus tard.

Validation : 96 tests du cœur et 14 tests des adaptateurs ; trois tests d'interop Rust ; package strict NodeNext/Node ; matrice Bun/Node/Deno/Chromium ; scénario WebSocket à deux onglets et reconnexion. La review indépendante a confirmé les contrôles de cache, de quota transactionnel, d'isolation et de causalité. Un test compte zéro appel à l'encodeur au commit local et un seul après plusieurs lectures/exportations.

Les suites complètes contiennent 35 et 85 résultats, cinq échauffements puis 25 échantillons mesurés. Les durées sont des médianes de moyennes par échantillon. La suite CRDT garde le même protocole de mesure. La suite complémentaire corrige aussi son chronométrage de création : préparation des fixtures et destruction hors mesure, objets retenus jusqu'à la fin pour les deux participants. Sa nouvelle valeur `creationTiming` rend les anciennes références incompatibles avec le comparateur automatique ; ses nombres avant/après sont donc contextuels.

Les exécutions intermédiaires montrant des variations simultanées dans les contrôles inchangés sont conservées dans `benchmarks/results/*lazy*.json`. Les tableaux ci-dessous et les rapports complets utilisent la dernière exécution complète, sans assemblage de cas choisis dans différentes exécutions.

## crdt-comparison

Avant : 2026-11-03T21:23:52.153Z. Après : 2026-11-03T21:57:01.580Z.

[JSON avant](baselines/crdt-comparison-before-lazy-encoding.json) · [JSON après](baselines/crdt-comparison-before-independent-audit.json)

| Scénario | Pulsify avant µs | Pulsify après µs | json-joy avant µs | json-joy après µs |
| --- | ---: | ---: | ---: | ---: |
| `create/10` | 21.42 | 13.06 | 8.85 | 8.86 |
| `create/1000` | 866.94 | 473.31 | 469.27 | 457.23 |
| `create+encode/1000` | 888.12 | 893.40 | 720.15 | 720.44 |
| `mutate/history-0` | 1.83 | 1.56 | 0.35 | 0.37 |
| `mutate/history-1000` | 1.55 | 1.40 | 0.29 | 0.28 |
| `mutate/history-5000` | 1.48 | 1.26 | 0.27 | 0.25 |
| `list-append/10` | 9.17 | 8.96 | 0.94 | 0.95 |
| `edit+encode/10` | 2.71 | 3.00 | 2.61 | 2.57 |
| `delta-roundtrip/1000` | 25.57 | 23.98 | 155.43 | 166.68 |
| `initial-load+materialize/1000` | 1840.42 | 1782.21 | 695.54 | 652.44 |

## local-bun

Avant : 2026-11-03T21:23:39.549Z. Après : 2026-11-03T21:56:49.628Z.

[JSON avant](baselines/local-bun-before-lazy-encoding.json) · [JSON après](baselines/local-bun-before-independent-audit.json)

| Cas | Avant µs | Après µs |
| --- | ---: | ---: |
| `core/create/10` | 20.28 | 12.88 |
| `json-joy/create/10` | 8.54 | 8.04 |
| `core/create/1000` | 1013.06 | 494.90 |
| `json-joy/create/1000` | 435.71 | 412.35 |

## Mémoire avant le premier export

Pour 5,001 lignes retenues, le heap observé après GC passe de 2,133,655 octets (2.03 MiB, journal déjà binaire) à 4,856,703 octets (4.63 MiB, patches natifs). C'est le coût mesuré de la rétention des objets natifs avant sérialisation. Le premier export remplace ensuite chaque getter natif demandé par ses octets ; le heap après export n'est pas mesuré dans ce tableau.

Ces mesures sont diagnostiques, pas une mesure RSS ni une preuve de fuite. Les contrôles inchangés et les distributions complètes restent disponibles dans les JSON.
