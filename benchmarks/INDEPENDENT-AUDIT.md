# Independent benchmark audit and corrective recheck

The original read-only audit below records the pre-correction code and its 120 executed measurements. Both findings have since been fixed, and first/repeated export cases have been added. The same independent agent reviewed these corrections; its recheck is appended unchanged. Fresh corrected reports contain 35 core and 95 CRDT results. No runtime library source was changed by this audit follow-up.

Original execution artifacts: [core JSON](results/independent-audit/core.json), [CRDT JSON](results/independent-audit/crdt-comparison.json), [diagnostic JSON](results/independent-audit/diagnostics.json). These local generated artifacts remain under the ignored results directory. Current saved references are in [baselines](baselines/).

## Corrected-run validation and timing conditions

The parent executed the corrected 35-case core suite and extended 95-case CRDT suite sequentially, with 5 warmups and 25 measured samples; every embedded payload/convergence check passed. TypeScript checking and the 15 adapter/comparator tests passed. The independent agent rechecked the source corrections before these runs.

The new core mutation and initial-load timing parameters intentionally prevent old core baselines from being compared with the corrected protocol. The CRDT task comparisons retain their documented formats and history policies. They measure complete tasks, not equivalent feature sets or isolated codec/Proxy instructions.

This machine was busy with unrelated CPU-heavy processes: one observed load average was 13.19/12.22/10.75 on 10 logical cores after the corrected runs. Wide sample distributions and movement in unchanged controls are visible in the raw reports. Treat the current timings as execution evidence and provisional observations, not precise speed ratios or release regression gates. The local [timing context](results/independent-audit/timing-context.json) records the observations; a quiet environment is required for performance conclusions.

---

# Audit indépendant des benchmarks — 2026-11-04

Audit en lecture seule des sources. Aucun baseline ni rapport publié écrasé. Exécutions séquentielles, sans autre benchmark simultané.

## Vérifications exécutées

- `bun test benchmarks/crdt-adapters.test.ts` : 14 tests, 64 assertions, 0 échec.
- `bun benchmarks/index.ts --output benchmarks/results/independent-audit/core.json` : 35 résultats complets, 5 warmups + 25 échantillons, terminé à 2026-11-04T01:14:59.714Z.
- `bun benchmarks/crdt-comparison.ts --output benchmarks/results/independent-audit/crdt-comparison.json --markdown benchmarks/results/independent-audit/crdt-comparison.md` : 85 résultats complets, même nombre de warmups/échantillons, terminé à 2026-11-04T01:15:28.095Z. Toutes les vérifications de convergence intégrées ont réussi.
- Diagnostic de wrappers WASM : 50 cycles de création/import/20 éditions + append/export/snapshot/destruction ; interception de FinalizationRegistry avec tokens maintenus vivants. Aucun wrapper WASM enregistré restant après free explicites. Ceci vérifie les handles JS, pas le heap natif ni la restitution de mémoire WASM à l'OS.
- `diagnostics.ts` / `diagnostics.json` : diagnostic additionnel après les suites, pas une nouvelle baseline. Vérifie aussi l'import et l'état de chaque deuxième export.

## Observations actionnables

### P2 — chemin d'accès asymétrique dans la comparaison core/mutate

`benchmarks/index.ts:277` exécute `pulse.nested.count = ...` à chaque mutation ; `index.ts:288-292` conserve au contraire le conteneur json-joy dans `nested`, préparé hors chronométrage. Les itérations diffèrent aussi (200 / 1000 en mode complet). La comparaison juxtapose donc recherche d'un chemin public + mutation et mutation d'un conteneur déjà résolu, plutôt que la seule surcharge du commit/journal.

Diagnostic avec le même nombre de 200 opérations, warmup 5 / 25 échantillons, fixture identique et GC hors timing : chemin Pulsify 2.5175 µs/op, conteneur Pulsify mis en cache 1.3831 µs/op, json-joy mis en cache 0.3575 µs/op. Le temps imputé au chemin public est significatif. Les valeurs sont diagnostiques ; l'ordre de ces trois variantes est fixe.

Action : aligner les références et nombres d'opérations, ou renommer/documenter explicitement la comparaison de chemins différents. La suite CRDT et sa comparaison à trois couches mettent déjà le conteneur en cache pour tous ; utiliser ces résultats pour conclure sur le surcoût du pipeline/proxy.

### P2 — destruction dans le chronométrage du chargement initial core

`benchmarks/index.ts:394` appelle `destroyPulse(loaded)` depuis `run()`. Le chrono à `index.ts:67-72` l'inclut. Cela contredit la méthode « cleanup outside the timed interval » dans `benchmarks/README.md:28`, et diffère du cas CRDT `initial-load+materialize`, où les répliques sont retenues puis libérées dans `dispose()`.

Action : retenir les répliques chargées jusqu'au dispose de l'échantillon, ou nommer le cas chargement + destruction et corriger la méthode annoncée. Les valeurs actuelles restent utilisables pour ce cycle complet, pas comme temps de chargement seul.

### Couverture à compléter — export initial versus export répété

`crdt-comparison.ts:175-203` mesure création + premier export ; `:266-298` encode de nouvelles mutations à chaque fois ; `:345-378` prépare l'export initial hors timing. Aucun cas canonique n'isole le premier export d'un état local préparé de l'export répété sans modification. Les chiffres `codec/encode` de la suite core encodent l'enveloppe avec les opérations déjà binaires et ne mesurent pas cette transition du journal natif.

Diagnostic sur 1000 éléments (médianes µs/export) : Pulsify 537.58 premier / 12.96 deuxième ; json-joy 282.54 / 259.50 ; Yjs V2 222.54 / 164.17 ; Loro 1780.08 / 59.08. Les tailles et états transférés sont identiques entre premier et deuxième export pour chaque moteur ; l'import du deuxième export restitue la fixture. Le diagnostic conserve l'ordre premier puis deuxième par définition, ne représente pas une régression comparée à une baseline et ne doit pas remplacer les suites.

Action : ajouter deux scénarios identifiés, état préparé hors timing puis premier export, et export après cache préparé hors timing. Les deux doivent retenir une réplique neuve par échantillon et contrôler le résultat hors chrono. Jusqu'alors, les gains de cache sont garantis fonctionnellement par les tests mais ne sont pas quantifiés par un scénario officiel.

## Comparaisons défendables en l'état

- Suite CRDT : graphes éditables équivalents, chaînes atomiques dans les quatre moteurs ; chaque mutation scalaire, ajout de map et suppression constitue une transaction/commit de l'API locale. Aucun Y.Text/LoroText ni blob JSON remplaçant un conteneur CRDT. La lecture/mutation scalaire cache le même niveau de conteneur pour tous.
- Préparation/GC des scénarios CRDT hors chrono, objets de création conservés jusqu'à la fin, destruction hors chrono, 5 warmups puis 25 états neufs mesurés, ordre des participants mélangé avec graine stable. Les p95 sont correctement décrits comme p95 des moyennes d'échantillons.
- Comparaison trois couches : mêmes historiques exportés exactement pour Pulsify direct/public, sans encodage local. L'écart direct/public comprend les gardes et conversions de valeurs du setter en plus des traps ; ne pas l'interpréter comme un profil d'instructions de Proxy.
- Création seule versus création + premier export : séparation effective de la conversion/encodage différés ; les fixtures sont préparées hors chrono.
- `edit+encode`, `delta-roundtrip`, chargement matérialisé, offline merge et conflit 16 pairs sont défendables comme coûts de ces tâches complètes avec les API/formats documentés, pas comme comparaison des seuls codecs.
- Les cas de la suite core encode/decode des enveloppes et des opérations JSON/binaire sont des comparaisons de même couche pour ces fixtures. Les enveloppes ne décodent pas les opérations et les documents l'indiquent.

## Différences de fonctionnalités assumées, pas des bugs de benchmark

Pulsify garde et transmet chaque segment avec identifiant et vecteurs, et valide son protocole ; json-joy produit snapshots/deltas structurels, pouvant condenser les écritures écrasées ; Yjs garde son GC par défaut et compare V2/V1 séparément ; Loro exporte snapshot avec historique et updates WASM. Les tailles et temps après 100 éditions offline ne représentent donc pas la même capacité de restauration historique. Les documents explicitent ces différences ; elles interdisent une conclusion générale « moteur/codec le plus rapide » mais pas la comparaison de tâches en usage par défaut.

Le backend Loro est WASM Node chargé une fois, sans coût de démarrage ni classement mémoire JS contre WASM. Aucun défaut de convergence ou fuite de wrapper WASM n'a été démontré. La quantité native retenue/fragmentation de l'allocateur WASM n'a pas été mesurée.

## Verdict

La suite CRDT compare correctement les tâches et données annoncées, avec des différences de services clairement documentées. Corriger ou étiqueter les deux asymétries de la suite core avant d'en tirer des ratios apples-to-apples. Ajouter une mesure officielle premier/export répété si l'on veut quantifier le cache introduit par l'encodage différé. Aucun défaut fonctionnel démontré pendant l'exécution.


---

# Recontrôle ciblé après audit

Les deux observations P2 de `AUDIT.md` sont corrigées dans les sources :

- `benchmarks/index.ts:274-279` résout le conteneur Pulsify hors chrono ; `:287` utilise les mêmes 50/200 itérations pour json-joy ; la fixture native inclut désormais les mêmes métadonnées gérées.
- `benchmarks/index.ts:390-404` conserve les récepteurs du chargement initial et les détruit dans `dispose()`, hors chrono.

La couverture d'export est complétée dans `benchmarks/crdt-comparison.ts:193-226` : `export-first/1000` et `export-repeat/1000` exécutent chacun un seul export par échantillon neuf. Construction et premier export préparatoire du cas repeat sont hors chrono, puis le harness force le GC hors chrono. Le paquet mesuré reste vivant jusqu'à sa vérification ; import, état JSON et destruction sont hors chrono. Les mêmes participants/formats et données sont utilisés pour les deux scénarios.

Les nouveaux paramètres mutationTiming et initialLoadTiming permettent de distinguer le nouveau protocole de la suite core de l'ancien. Le rapport AUDIT.md et les résultats historiques ne sont pas modifiés.

Validation du recontrôle : inspection ciblée des sources et 14 tests adaptateurs / 64 assertions réussis. Aucun benchmark relancé pendant l'exécution du parent ; aucun chiffre antérieur présenté comme mesure du protocole corrigé.

Verdict : les observations de l'audit sont résolues. Les comparaisons sont défendables pour les tâches et différences de fonctionnalités documentées. Aucun problème concret restant dans ce recontrôle.
