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
