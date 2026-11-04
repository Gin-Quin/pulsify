# Suppression de la validation de schéma supplémentaire

Pulsify appelait un validateur récursif du schéma avant chaque encodage et un lecteur préalable du format binaire avant chaque décodage. Ces deux parcours ont été supprimés : le schéma est traité directement par codec. Le petit adaptateur `wireCodec` ne conserve que la limite de taille de trame, la consommation complète des octets et la conversion des erreurs. Les règles de cohérence du protocole et du journal CRDT restent dans Pulsify.

Les deux suites complètes ont été relancées séquentiellement : 35 et 85 résultats, cinq échantillons d'échauffement puis 25 mesurés. Les valeurs sont les médianes des moyennes par échantillon. Environnement : Bun 1.4.4, codec 2.1.0, json-joy 18.28.0, Apple M4 / arm64 ; Yjs 13.6.33 et Loro 1.17.1 WASM pour la comparaison CRDT.

Il s'agit de deux exécutions séparées, pas d'une mesure appariée dans un même processus : le bruit, la charge système et le JIT influencent aussi les différences. Les pourcentages ne constituent pas une attribution exacte du temps au code supprimé. Les valeurs des bibliothèques inchangées varient également ; elles sont toutes conservées dans les JSON et dans le [rapport CRDT actuel](CRDT-COMPARISON.md).

## local-bun

Avant : 2026-11-03T16:58:35.732Z. Après : 2026-11-03T17:42:18.541Z.

[JSON avant](baselines/local-bun-with-schema-validation.json) · [JSON après](baselines/local-bun-before-runtime-simplification.json)

| Cas | Avant µs/op | Après µs/op | Variation observée |
| --- | ---: | ---: | ---: | ---: |
| `codec/encode/100` | 0.86 | 0.44 | -48.6 % |
| `codec/decode/100` | 0.67 | 0.28 | -58.6 % |
| `operations/encode/100` | 92.64 | 34.51 | -62.8 % |
| `operations/decode/100` | 157.45 | 54.31 | -65.5 % |
| `core/mutate/history-0` | 3.02 | 2.62 | -13.2 % |
| `sync/initial-load/1000` | 4343.52 | 2887.33 | -33.5 % |

## crdt-comparison

Avant : 2026-11-03T17:19:36.405Z. Après : 2026-11-03T17:42:32.462Z.

[JSON avant](baselines/crdt-comparison-with-schema-validation.json) · [JSON après](baselines/crdt-comparison-before-runtime-simplification.json)

| Cas | Avant µs/op | Après µs/op | Variation observée |
| --- | ---: | ---: | ---: | ---: |
| `crdt/edit+encode/10/pulsify` | 6.95 | 2.76 | -60.3 % |
| `crdt/delta-roundtrip/1000/pulsify` | 1641.53 | 1023.47 | -37.7 % |
| `crdt/initial-load+materialize/1000/pulsify` | 16487.87 | 3375.27 | -79.5 % |
| `crdt/proxy-overhead/mutate-history-0/pulsify-direct` | 2.12 | 1.36 | -36.0 % |
| `crdt/proxy-overhead/mutate-history-0/pulsify-proxy` | 2.29 | 1.50 | -34.3 % |

