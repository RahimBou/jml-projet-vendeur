# Cartographie des estimations et plan de migration sans régression

Dépôt : RahimBou/jml-projet-vendeur
Date : 10 octobre 2026
Périmètre : cartographie statique du fichier `server.js`, sans modification du code applicatif.

## Garantie de non-régression

Ce relevé ne change aucune page, route, formule, table ou variable d'environnement. Les seules modifications de dépôt à ce stade sont des documents sous `docs/`. Toute refactorisation ultérieure devra être faite en petits changements, avec conservation des contrats JSON actuels et tests avant déploiement.

## Routes et services repérés

| Route / service | Rôle constaté | Dépendances |
|---|---|---|
| `GET /api/dvfplus-market-summary` | Résumé annuel DVF+ : volumes, comparables éligibles, médianes et signal de tendance | Table `jml_dvfplus_sales` |
| `GET /api/dvf-quality` | Contrôle de cohérence des ventes DVF importées | Table `jml_dvf_sales` |
| `GET /api/commune-market` | Repère statistique communal et historique | `getCommuneMarketData`, DVF PostgreSQL et source externe de secours |
| `GET /api/external-market-benchmarks` | Collecte de repères d'estimateurs externes | `getPublicMarketBenchmarks`, géocodage |
| `GET /api/territory-comparables` | Expose la recherche de ventes comparables sans charger le marché communal | `buildComparableSales` |
| `GET /api/territory-summary` | Orchestre marché communal, comparables, communes voisines, repères externes et repère vendeur | `getCommuneMarketData`, `buildComparableSales`, estimateurs externes et Flatway |
| `POST /api/estimator-agent/run` | Lance l'agent d'estimateurs externes après contrôle par secret | `runEstimatorAgent` |
| Fonctions `buildComparableSales` et `getLocalDvfComparables` | Recherche, filtre et pondère les ventes locales | DVF PostgreSQL, DVF+ Cerema, géocodage et enrichissement DPE |
| Fonction `buildSellerReference` | Produit un repère communal simple avec une fourchette ±15 % | Prix médian communal par type et surface |

Les noms ci-dessus proviennent de la lecture statique du serveur ; le comportement en production et les appels depuis les pages clientes restent à vérifier.

## Chaîne du moteur comparable repérée

1. Géocoder l'adresse et déterminer le centre de recherche.
2. Interroger les ventes locales PostgreSQL et les ventes DVF+ Cerema.
3. Normaliser les transactions et filtrer les candidats par type, distance, date et surface comparable.
4. Dédupliquer actuellement en priorité par identifiant de vente.
5. Calculer un score de similarité (distance, surface, pièces, terrain, récence et proximité d'adresse).
6. Revaloriser temporellement les prix à l'aide d'une médiane annuelle locale lorsque suffisamment de données existent ; facteur plafonné à ±15 %.
7. Calculer la cohérence de prix et réduire le poids de certaines valeurs atypiques.
8. Produire une médiane pondérée, des quartiles, une fourchette et un niveau de confiance.
9. Enrichir secondairement quelques ventes avec les données DPE ADEME.
10. Retourner des diagnostics et une trace de calcul partielle.

## Points à vérifier avant toute modification

- **Déduplication multi-source :** les identifiants DVF PostgreSQL et DVF+ Cerema peuvent différer pour une même mutation. La déduplication par ID seul ne garantit donc pas l'absence de doublons. Ajouter un rapprochement prudent sur date, prix, type, surface et position, avec journal des collisions, après tests.
- **Surface :** la normalisation emploie par endroits `surface_reelle_bati` et `surface_batie_dvf`. Il faut éviter de présenter cette surface comme la surface habitable sans preuve.
- **Vente exacte :** `territory-summary` peut prioriser une vente DVF+ reconnue à la même adresse si la surface est proche. Vérifier l'identité de la mutation et le niveau de précision d'adresse avant de maintenir cette priorité.
- **Confiance :** contrôler que les niveaux de confiance tiennent compte des ventes uniques après déduplication, de la qualité de géocodage, de la période, du type et des données manquantes.
- **Source de secours :** quand aucun comparable utilisable n'est trouvé, `territory-summary` peut basculer vers le prix communal par type. Ce fallback doit rester explicitement identifié comme tel dans chaque page.
- **Temporalité :** l'index temporel est calculé sur les candidats et les ajustements sont plafonnés ; tester les petits échantillons, les années incomplètes et les ruptures de marché.
- **Fourchette :** les quartiles ou les marges conventionnelles de 10–15 % ne sont pas un intervalle de confiance statistique. Le libellé vendeur doit le préciser.
- **Prix propriétaire :** vérifier par test que toute valeur saisie par le propriétaire n'entre jamais dans les entrées de `buildComparableSales` ni dans la pondération.
- **Timeout :** `territory-summary` peut renvoyer un résultat de repli après 18 secondes ; les pages doivent distinguer délai dépassé et absence réelle de ventes.
- **Routes clientes :** inventorier les appels fetch de chaque page et vérifier les contrats de réponse avant d'extraire des fonctions dans de nouveaux modules.

## Stratégie de migration sans casser les pages

### Phase A — Cartographie seulement
- Capturer les contrats JSON actuels et les exemples de réponse.
- Relever les appels front-end à chaque route et les champs affichés.
- Exporter la liste des routes, tables, variables d'environnement et tâches d'import.
- Ajouter des tests de caractérisation pour les cas existants.

### Phase B — Trace sans changement de formule
- Introduire une fonction pure de construction de trace et l'appeler sans changer les valeurs calculées.
- Ajouter des diagnostics explicites pour candidats trouvés, retenus, exclus et source de secours.
- Comparer les sorties avant/après sur des cas de référence ; les différences doivent être nulles hors champs de diagnostic.

### Phase C — Services partagés par adaptateurs
- Extraire d'abord les normaliseurs en modules isolés, en conservant les noms/structures attendus par le serveur.
- Ajouter une déduplication multi-source en mode observation uniquement ; ne pas modifier les valeurs publiées avant validation.
- Mettre les nouveaux services derrière des drapeaux de fonctionnalité désactivés par défaut.

### Phase D — Activation progressive
- Activer en test, comparer ancien/nouveau calcul sur des biens de référence.
- Vérifier les pages estimation, territoire, dossier vendeur et les outils qui consomment l'API.
- Déployer après validation ; conserver un retour arrière simple vers le chemin existant.

## Tests de non-régression obligatoires

1. Contrats HTTP : mêmes routes, codes de statut et champs JSON requis.
2. Formulaires : champs saisis, actualisation, bouton retour et affichage des résultats.
3. Valeur indépendante du prix attendu du propriétaire.
4. Adresse exacte, rue voisine, géocodage communal de secours et adresse introuvable.
5. Maison, appartement, terrain, surface manquante et surfaces non comparables.
6. Doublon DVF/DVF+ de même mutation.
7. Zéro comparable, faible volume, ventes atypiques et données trop anciennes.
8. Source externe indisponible, API lente, timeout et table non disponible.
9. Build et tests CI, puis vérification de santé après déploiement Render.

## Décision recommandée

Ne pas refactoriser directement les 5 000+ lignes de `server.js`. Commencer par des tests de caractérisation et un journal de calcul, puis extraire une responsabilité à la fois. Aucune modification du moteur en production tant que les cas de référence ne sont pas reproductibles.
