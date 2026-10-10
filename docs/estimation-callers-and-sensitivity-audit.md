# Audit des appels clients et sensibilité — estimation JML

Dépôt : `RahimBou/jml-projet-vendeur`
Date : 10 octobre 2026
Périmètre : lecture statique de `server.js`, `public/espace-vendeur.html`, `public/vendeur-secteur.html` et `public/projet-vendeur.html`. Aucun code applicatif ni calcul de production modifié.

## Garantie de non-régression

Cette étape ajoute uniquement un document d'audit. Aucune route, formule, page, variable d'environnement ou donnée n'a été modifiée. Les résultats de production n'ont pas été rejoués : la sensibilité ci-dessous est une analyse statique du code, pas encore un test dynamique.

## Chaîne d'appel repérée

### 1. Tableau de bord vendeur

`public/espace-vendeur.html` — fonction `loadSellerDashboardData(d)` (environ lignes 1640–1720) :
- construit les paramètres depuis le dossier vendeur : commune, adresse, type, surface, terrain et pièces ;
- appelle `GET /api/territory-summary` ;
- lit `data.sellerReference`, `data.market` et `data.diagnostics` ;
- en cas d'échec, appelle `GET /api/commune-market` pour conserver un affichage de secours.

### 2. Page « Mon secteur »

`public/vendeur-secteur.html` (environ lignes 2010–2095) :
- appelle séparément `GET /api/commune-market` ;
- appelle `GET /api/territory-comparables` avec les caractéristiques du dossier ;
- calcule ensuite une valeur dans le navigateur à partir de `comps.weightedPriceM2 × surface` ;
- construit `valuationBlend` avec une seule composante « DVF comparables », poids 1 ;
- si la recherche échoue, affiche le repère communal comme contexte de secours, avec confiance faible.

### 3. Page de projet vendeur

`public/projet-vendeur.html` contient les appels de chargement/sauvegarde du dossier et de création de prospect (`/api/seller-space/…`, `/api/leads`). Dans les correspondances statiques relevées, elle ne calcule pas directement la valeur immobilière et n'appelle pas directement `/api/territory-summary`. La chaîne de calcul observée passe par les pages de tableau de bord et de secteur.

## Routes d'estimation et responsabilités

| Route | Responsabilité observée |
|---|---|
| `GET /api/territory-summary` | Orchestre marché communal, comparables, contrôle externe/Flatway et repère vendeur |
| `GET /api/territory-comparables` | Retourne les comparables DVF pondérés, sans charger le marché communal |
| `GET /api/commune-market` | Fournit les statistiques et transactions communales |
| `GET /api/external-market-benchmarks` | Retourne les repères externes et leur médiane de contrôle |
| `POST /api/estimator-agent/run` | Lance l'agent d'estimateurs externes, protégé par secret |

## Constat prioritaire : deux chemins de calcul différents

### A. Route `/api/territory-summary`

Dans le code actuel :
1. Une vente DVF+ récente reconnue à la même adresse peut être prioritaire si sa surface est à ±15 % de la surface du dossier.
2. Sinon, si `comparable.weightedPriceM2` est positif, `referenceBase` prend cette valeur sans intégrer le micro-marché ni la médiane externe dans la formule.
3. Sinon, le moteur utilise le prix communal par type de bien.
4. La valeur est `referenceBase × surface` (ou surface de terrain pour un terrain).

Les valeurs micro-marché et estimateurs externes sont bien collectées et exposées dans les champs de diagnostic, mais le `valuationBlend` actuellement construit pour une vente exacte ou des comparables ne contient qu'une composante à poids 1. Cela ne correspond donc pas à une formule effective « DVF 50 % + micro-marché 30 % + externes 20 % » dans ce chemin de code, même si certains textes d'explication parlent de repère hybride.

### B. Page `vendeur-secteur.html`

Cette page calcule sa propre valeur après l'appel `/api/territory-comparables` :
- `referenceM2 = comps.weightedPriceM2` ;
- `referenceValue = referenceM2 × surface` ;
- `valuationBlend` indique uniquement « DVF comparables », poids 1.

Elle ne consomme pas la valeur `sellerReference.referenceValue` calculée par `/api/territory-summary` pour afficher son repère. Le tableau de bord et « Mon secteur » peuvent donc afficher des repères différents selon la disponibilité des données, la vente exacte récente et les paramètres de secours.

## Analyse statique de sensibilité — avant tout changement

La valeur devrait varier de façon prévisible lorsqu'on modifie les paramètres suivants :

| Entrée modifiée | Effet attendu dans le code actuel | Point à vérifier dynamiquement |
|---|---|---|
| Surface habitable | Valeur totale proportionnelle à la surface ; la sélection/pondération des comparables peut aussi changer | À prix/m² constant, +10 % de surface doit donner +10 % de valeur totale |
| Surface de terrain (terrain à vendre) | Utilisée comme surface de valorisation pour un terrain ; peut influencer le filtrage des ventes | Vérifier que les maisons ne sont pas traitées comme des terrains |
| Type de bien | Change le filtrage des transactions et la référence communale de secours | Passer maison → appartement doit modifier le jeu de ventes ou rendre le calcul indisponible, jamais conserver silencieusement une base incompatible |
| Adresse | Change le géocodage, le rayon et les scores de distance/rue/adresse ; peut activer la priorité de vente exacte | Déplacer l'adresse doit modifier les diagnostics et potentiellement les comparables |
| Pièces | Filtre les comparables avec un écart supérieur à deux pièces et modifie le score | Tester une variation qui franchit la limite de deux pièces |
| DVF/DVF+ | Modifie la population de candidats et potentiellement le prix pondéré | Comparer les candidats uniques et rechercher les mutations présentes dans plusieurs sources |
| Prix envisagé par le propriétaire | Ne doit avoir aucun effet sur la valeur automatique | Vérifier que le champ n'est pas envoyé au calcul, ni utilisé indirectement dans un poids ou une valeur de secours |
| Micro-marché et estimateurs externes | Actuellement exposés comme contrôles dans `territory-summary`, mais pas incorporés dans le `referenceBase` observé | Si la pondération 50/30/20 reste la règle retenue, ajouter d'abord des tests qui établissent exactement le comportement attendu, puis modifier sous contrôle |

## Risques et corrections à planifier — sans les activer maintenant

1. **Source de vérité unique :** éviter que le serveur et `vendeur-secteur.html` calculent chacun leur propre repère final. La page devrait à terme afficher la valeur d'un service serveur commun, en conservant le format de réponse attendu.
2. **Trace détaillée :** enregistrer les entrées normalisées, les ventes candidates, les raisons d'exclusion, les scores par composante, la revalorisation temporelle, les poids finaux, les sources absentes, la méthode de secours et les calculs arithmétiques.
3. **Sensibilité reproductible :** capturer d'abord la réponse de référence, puis rejouer un jeu de cas contrôlés : surface ×0,9/×1,1, adresse voisine, type incompatible, pièces ±1/±3, suppression d'une source, et prix propriétaire modifié seul.
4. **Doublons :** tester les mutations partagées entre DVF PostgreSQL, DVF+ Cerema et ventes communales ; ne pas changer la déduplication en production avant de mesurer son effet.
5. **Explications affichées :** aligner les textes « hybride » sur la formule réellement exécutée et afficher clairement si la valeur est issue d'une vente exacte, de comparables ou d'un secours communal.

## Étape suivante

Avant de changer la formule :
- établir des tests de caractérisation pour les deux routes ;
- comparer la valeur de référence du cas du 6 rue Payen-Guillemain avec des entrées et sorties explicites ;
- produire une trace qui ne modifie pas le calcul ;
- vérifier que le prix envisagé par le propriétaire est totalement indépendant ;
- seulement ensuite, proposer une modification minimale avec test de non-régression des deux pages.

**Conclusion :** l'audit statique met en évidence une incohérence réelle entre les explications du repère « hybride » et les pondérations réellement appliquées, ainsi que deux chemins de calcul distincts. Ce constat justifie la prochaine phase de traçabilité et de tests, mais ne prouve pas à lui seul que le résultat du cas de référence est codé en dur.
