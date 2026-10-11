# Vérification du chemin d'estimation et plan de sensibilité

Dépôt : `RahimBou/jml-projet-vendeur`  
Date : 11 octobre 2026  
Branche de travail : `fix/weighted-median-scope`  
Périmètre : lecture statique du serveur et des pages consommatrices. Aucune donnée PostgreSQL de production n'est accessible via le dépôt GitHub ; le cas du 6 rue Payen-Guillemain n'a donc pas encore été rejoué sur les ventes réellement chargées dans Render.

## 1. Chemin de calcul confirmé

### Tableau de bord — `GET /api/territory-summary`

1. Résout la commune.
2. Charge le marché communal par `getCommuneMarketData`.
   - priorité à `jml_dvf_sales` dans PostgreSQL ;
   - si aucune donnée exploitable n'est trouvée, recours aux données DVF publiques Cquest ;
   - le résultat communal est mis en cache jusqu'à six heures.
3. Lance `buildComparableSales` avec adresse, type, surface, terrain, pièces et commune.
4. Récupère séparément les repères externes et le repère Flatway.
5. Choisit la base du repère vendeur :
   - vente récente à l'adresse exacte si elle est détectée et si la surface est jugée compatible ;
   - sinon prix/m² des comparables s'il est positif ;
   - sinon prix communal correspondant au type.
6. Calcule le total par `Math.round(referenceBase * sellerSurface)`.

**Point important :** les repères externes et Flatway sont exposés pour contrôler le résultat, mais le `valuationBlend` effectif reste à poids 100 % pour la vente exacte ou les comparables. La pondération 50/30/20 n'est pas celle exécutée par ce chemin.

### Page « Mon secteur » — `GET /api/territory-comparables`

La page récupère le marché communal et les comparables par deux appels séparés, puis calcule son propre total à partir du prix/m² des comparables et de la surface. Elle n'utilise pas exactement la même décision finale que `territory-summary`. Il existe donc deux chemins de calcul qui peuvent légitimement diverger.

## 2. Secours et modes dégradés

| Situation | Comportement observé | Risque |
|---|---|---|
| Aucun comparable retenu | Le moteur renvoie un prix/m² nul ; le résumé utilise alors le prix communal si disponible | Une valeur peut sembler figée car elle dépend seulement de la médiane communale |
| Recherche comparables au-delà de 18 s | `territory-summary` retourne un jeu vide avec un diagnostic de délai dépassé | Le repère communal peut s'afficher comme s'il s'agissait du repère personnalisé, malgré un message de secours |
| Erreur de requête PostgreSQL ou DVF+ dans `buildComparableSales` | Les erreurs de chaque source sont converties en tableaux vides après journalisation | Une panne de source peut être présentée comme « aucune vente compatible » ; l'absence de données et l'échec de collecte ne sont pas toujours distingués |
| De 1 à 4 comparables positifs | La base peut tout de même utiliser leur prix/m², même si `useComparableReference` exige au moins 5 ventes | Le texte de confiance/explication peut parler de secours alors que la valeur centrale vient de comparables insuffisants |
| Cache du marché communal actif | Le marché communal peut rester identique pendant six heures | Le prix communal peut ne pas refléter immédiatement un import de données récent |

### Vente exacte à l'adresse

Le chemin de priorité `exactRecentSale` exige une surface comparable. Les ventes DVF sont normalisées avec la base `surface_batie_dvf`, tandis que les paramètres passés par les pages n'incluent pas `surfaceBasis`. La comparaison stricte des bases peut donc empêcher `surfaceGap` d'être renseigné et rendre la vente exacte inéligible à cette priorité. **Ne pas corriger cela en assimilant arbitrairement surface habitable et surface bâtie** : il faut d'abord choisir une règle métier explicite, car les deux mesures ne sont pas interchangeables.

### Déduplication DVF / DVF+

La fusion des sources déduplique actuellement d'abord par identifiant. Si une même mutation possède des identifiants différents selon les sources, elle peut compter deux fois. Un rapprochement robuste doit s'appuyer sur plusieurs champs de mutation, puis être mesuré sur des données réelles avant activation.

## 3. Tests de sensibilité ajoutés

Le script `scripts/check-estimation-sensitivity.js` est exécuté par la CI. Il protège :
- la multiplication explicite du prix/m² par la surface ;
- le filtre du type de bien dans le moteur de comparables ;
- la séparation entre prix envisagé du propriétaire et valeur automatique ;
- la présence des routes et champs JSON attendus par les pages existantes ;
- des exemples arithmétiques reproductibles à base constante de 1 704 €/m².

Exemple de caractérisation arithmétique, **pas une nouvelle estimation du bien** :

| Surface | Calcul à 1 704 €/m² | Valeur |
|---:|---:|---:|
| 135 m² (-10 %) | 1 704 × 135 | 230 040 € |
| 150 m² | 1 704 × 150 | 255 600 € |
| 165 m² (+10 %) | 1 704 × 165 | 281 160 € |

Ces tests sont des garde-fous statiques et arithmétiques. Ils ne prouvent pas encore que PostgreSQL renvoie les mêmes ventes sur Render. Les tests dynamiques doivent rejouer les deux routes avec un jeu de données DVF fixe et comparer :
- surface 150 m², puis 135 et 165 m² ;
- maison puis appartement ;
- adresse d'origine puis adresse voisine ;
- ensemble de comparables complet, puis retrait/ajout contrôlé d'une vente ;
- prix envisagé du propriétaire modifié seul, qui doit laisser la valeur automatique strictement inchangée.

## 4. Cas de référence : 6 rue Payen-Guillemain

Ancien repère de travail mémorisé : environ 255 525 € pour 150 m², soit autour de 1 704 €/m². La multiplication exacte de 1 704 × 150 donne 255 600 € ; l'écart de 75 € indique que le chiffre historique a pu être calculé avec un prix/m² plus précis avant arrondi, ou une autre version des données. Ce n'est pas une preuve d'estimation actuelle.

Pour valider le cas réel, il faut conserver pour chaque exécution :
- les paramètres normalisés réellement reçus ;
- source et période du marché communal ;
- nombre de lignes PostgreSQL, DVF+ et marché communal ;
- nombre de candidats avant/après filtres, raisons d'exclusion et identifiants uniques ;
- prix/m² avant et après revalorisation temporelle ;
- scores, poids, médiane pondérée, vente gagnante et valeur finale ;
- `referenceSource`, `confidence`, état `timeout` et toute raison de repli.

À l'instant de cet audit, la base PostgreSQL de Render et sa réponse réelle ne sont pas accessibles depuis GitHub ; aucune nouvelle valeur n'est donc attribuée à cette adresse.

## 5. Non-régression

Les nouveaux garde-fous ne changent ni la formule de production, ni les pages, ni les routes, ni le contrat JSON. La correction d'ordre d'initialisation de la médiane pondérée reste dans la branche de travail. Ne fusionner ni déployer avant :
1. CI verte, y compris le nouveau script ;
2. replay des deux routes sur un jeu DVF fixe ;
3. comparaison avant/après des réponses JSON et vérification du cas de référence ;
4. confirmation qu'aucune page ne dépend d'un champ modifié.

**Conclusion :** une valeur figée peut provenir d'un secours communal, d'un jeu de comparables inchangé, du cache communal ou d'un échec de collecte masqué par un tableau vide. Le prochain correctif métier doit améliorer la traçabilité des modes dégradés avant de changer la formule.


## 6. Replay exploratoire sur le fichier DVF+ fourni

Le fichier disponible `maisons_dvf_autour_payer_guillemain_3km.csv` contient 1 131 mutations de maisons à moins de 3 km, datées du 3 janvier 2020 au 29 décembre 2025. En appliquant la fenêtre de 48 mois à la date de contrôle du 11 octobre 2026, il reste 559 ventes de maisons avec prix et surface bâtie exploitables ; 36 se trouvent à moins de 500 m.

Une simulation hors ligne de la logique de score et de pondération, à partir de ce fichier seul, donne :

| Scénario | Ventes candidates | Ventes après filtre statistique | Prix pondéré indicatif | Total à la surface du scénario |
|---|---:|---:|---:|---:|
| Maison, 135 m² | 559 | 549 | ~1 667 €/m² | ~225 000 € |
| Maison, 150 m² | 559 | 549 | ~1 667 €/m² | ~250 000 € |
| Maison, 165 m² | 559 | 549 | ~1 667 €/m² | ~275 000 € |
| Maison, 150 m², ventes à moins de 500 m exclues | 523 | 513 | ~1 643 €/m² | ~246 429 € |

Cette simulation illustre deux comportements :
- le prix au m² peut rester identique quand la variation de surface ne change pas le comparable qui franchit la médiane pondérée ;
- le total doit néanmoins évoluer avec la surface : ici, environ ±25 000 € pour ±15 m² à base constante ;
- retirer les ventes les plus proches modifie le prix pondéré simulé d'environ 1 667 à 1 643 €/m², soit environ -1,4 %.

Ventes très proches et récentes dans le fichier, à titre de contrôle de dispersion : à 34 m, 180 000 € pour 130 m² (~1 385 €/m², juin 2024) ; à 59 m, 315 000 € pour 157 m² (~2 006 €/m², juillet 2024) ; à 135 m, 295 000 € pour 116 m² (~2 543 €/m², août 2025) ; à 142 m, 290 000 € pour 130 m² (~2 231 €/m², avril 2025). Cette dispersion explique pourquoi il faut examiner les caractéristiques et le poids de chaque vente, et non la seule proximité.

**Limite à ne pas masquer :** ce n'est pas un replay du moteur de production. Le CSV n'expose pas toutes les colonnes utilisées par le moteur (adresse exacte, pièces, terrain, bases de surface, autres sources DVF/PostgreSQL et éventuels doublons). Le prix/m² simulé est donc un contrôle indépendant du jeu disponible, pas une valeur certifiée de l'API Render. Le fichier ne contient que des maisons : l'absence d'appartements dans cet extrait ne signifie pas qu'il n'existe aucune vente d'appartement dans le secteur.


## 7. Contrôle croisé avec des références publiques consultées le 11 octobre 2026

Sources publiques consultées pour l'adresse :
- Flatway, fiche du n°6 : https://flatway.fr/estimation/08/charleville-mezieres-08000-08105/rue-payer-guillemain-3090/6
  - 2 266 €/m² pour la maison, fourchette 1 740–2 861 €/m², confiance affichée 1/5 ;
  - bâtiment indiqué comme ancien (1905), 3 niveaux, 68 m² au sol ;
  - aucune vente recensée à cette adresse au cours des cinq dernières années ;
  - 33 ventes mixtes dans un rayon de moins de 100 m, comprenant notamment des appartements : ces ventes ne sont pas toutes des comparables de maison.
- Meilleurs Agents, fiche de la rue mise à jour au 1er octobre 2026 : https://www.meilleursagents.com/prix-immobilier/charleville-mezieres-08000/rue-payer-guillemain-1106437044/
  - maisons : 1 964 €/m² en moyenne sur la rue, fourchette 843–3 456 €/m² ;
  - appartements : 1 400 €/m² en moyenne ;
  - moyenne maisons annoncée pour Charleville-Mézières : 1 723 €/m² ;
  - évolution maisons annoncée : -0,5 % sur un an et +5,4 % sur cinq ans.

Ces valeurs externes sont des indices de marché, pas des prix de vente DVF et pas des estimations de la base de production. La confiance faible affichée par Flatway et les larges fourchettes de Meilleurs Agents interdisent d'en faire une vérité terrain.

### Rejeu local du fichier DVF+ disponible

Le CSV a été recalculé localement avec une approximation du score du moteur (distance, écart de surface bâtie vs surface du dossier, récence, cohérence des prix et revalorisation annuelle) et une origine géographique approximative proche des ventes les plus proches. Ce rejeu n'est **pas certifié exact**, car le CSV ne contient pas le géocodage officiel du numéro, les adresses de mutation, les pièces, les surfaces de terrain, la base de surface du dossier ni les ventes de la base PostgreSQL. Les résultats sont donc un contrôle exploratoire du fichier réel, pas une reproduction de l'API Render.

| Scénario simulé | Candidats évalués | Ventes retenues pour la valeur | Prix pondéré arrondi | Valeur pour la surface |
|---|---:|---:|---:|---:|
| Maison, 135 m² | 558 | 548 | 1 667 €/m² | 225 000 € |
| Maison, 150 m² | 558 | 548 | 1 667 €/m² | 250 000 € |
| Maison, 165 m² | 558 | 548 | 1 667 €/m² | 275 000 € |

L'origine approximative change légèrement les comptes par rapport au simple comptage du CSV : les 559 lignes dans la fenêtre temporelle ne deviennent pas toutes des candidates après le calcul de distance. L'API doit être rejouée avec ses coordonnées officielles pour certifier les nombres.

### Interprétation de l'écart

À 150 m², le fichier DVF+ simulé donne environ 250 000 € (1 667 €/m²), contre :
- environ 294 600 € en appliquant la moyenne de rue Meilleurs Agents de 1 964 €/m² ;
- environ 339 900 € en appliquant le repère Flatway du n°6 de 2 266 €/m².

Ces montants ne sont pas directement équivalents : les sources n'utilisent pas la même méthode, le même ensemble de biens ni nécessairement la même définition de surface. La fiche Flatway indique 68 m² au sol et trois niveaux, mais cela ne certifie pas une surface habitable de 150 m². **Il faut vérifier la surface habitable réelle du dossier avant de comparer des valeurs totales.**

### Ce qui manque pour clore le contrôle production

Le dépôt GitHub ne donne pas accès à `DATABASE_URL`, aux lignes de `jml_dvf_sales` / `jml_dvfplus_sales` de Render, ni aux variables d'environnement du service. La tentative de lecture publique de l'URL de santé Render n'a pas fourni de réponse exploitable via l'accès disponible ici. En conséquence, il n'est pas possible de prétendre avoir comparé la sortie de production.

Le dernier contrôle de production doit enregistrer, pour la même requête et sans modifier les données :
1. la réponse JSON brute de `/api/territory-comparables` ;
2. la réponse JSON brute de `/api/territory-summary` ;
3. `origin`, `originSource`, `postgresRows`, `freshRows`, `marketRows`, `candidateCount`, `valuationCount`, `weightedMedianSaleId`, `weightedMedianPriceM2`, `referenceSource`, `confidence` et les éventuels `timeout`/diagnostics ;
4. le même appel avec surface 135/150/165 m², puis type Appartement (contrôle négatif de cohérence pour ce fichier composé uniquement de maisons) ;
5. un appel identique après modification du seul prix envisagé par le propriétaire, qui doit laisser l'estimation automatique inchangée.

La PR demeure ouverte et non fusionnée. Le dernier run CI associé au commit `f44f5669dba6218a503750acfff6ebef7e468e4d` est vert. Aucune donnée de production ni aucune page n'a été modifiée.
