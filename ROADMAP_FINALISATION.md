# Feuille de route de finalisation — JML Projet Vendeur

**Date de référence : 11 octobre 2026**  
**Dépôt :** `RahimBou/jml-projet-vendeur`

## Règles de travail

1. Cette feuille de route est le point de départ unique pour la suite. Mettre à jour son statut après chaque étape terminée.
2. Ne pas refaire un audit ou un test déjà validé sans nouvel élément, changement de code ou échec reproductible.
3. Ne pas modifier les coefficients de valorisation avant d'avoir terminé l'audit du moteur sur les données réelles.
4. Ne pas confondre code commité, CI réussie, PR fusionnée, déploiement Render et validation fonctionnelle en production.
5. Préserver les pages, routes, contrats JSON et fonctionnalités existantes. Toute modification doit avoir des tests de non-régression.
6. DVF reste la preuve des ventes réelles. Les données INSEE, CCI, Notaires, annonces et autres sources sont des éléments de contexte ou de comparaison, pas des ventes DVF. Ne jamais présenter une donnée nationale comme une mesure locale.
7. L'année 2025 reste la dernière année de référence DVF à utiliser tant que les données 2026 ne sont pas publiées et intégrées.

## Contrat d'exécution — responsabilité de l'assistant

**La feuille de route est pilotée par l'assistant. L'utilisateur n'a pas à la gérer ni à se souvenir de la prochaine étape.**

À chaque reprise de travail sur JML Projet Vendeur, l'assistant doit :
1. relire cette feuille de route et reprendre à la première tâche non validée;
2. vérifier les derniers commits, PR, CI et déploiement pertinents avant de proposer un changement;
3. poursuivre l'action concrète la plus utile, sans redemander des contrôles déjà prouvés;
4. après chaque changement, contrôler le diff, lancer les vérifications adaptées et inspecter les éventuelles régressions;
5. distinguer clairement ce qui est commité, fusionné, déployé et testé en production;
6. mettre à jour cette feuille de route avec la preuve, le résultat et le statut de l'étape;
7. ne jamais marquer « Validé » sur la seule base d'une intention, d'un commit ou d'une CI si le test requis est un test de production;
8. si un test nécessite une action ou un accès de l'utilisateur, expliquer uniquement l'action minimale requise, puis reprendre l'audit dès que le résultat est disponible;
9. terminer chaque compte rendu par **la prochaine action précise** et la preuve attendue;
10. ne pas créer de nouvelle branche de travail ni élargir le périmètre sans raison documentée.

**Boucle obligatoire :** inspecter l'état actuel → agir sur le point prioritaire → tester → comparer au résultat attendu → vérifier les régressions → mettre à jour la feuille de route → passer au point suivant.

## P0 — Clôturer l'audit du moteur DVF avant toute nouvelle modification métier

### P0.1 — État exact du code et du déploiement
- [ ] Relever la branche et le commit actifs sur GitHub.
- [ ] Vérifier l'état, les contrôles CI et les changements des PR #12 (diagnostic/sensibilité) et #13 (initialisation de la médiane pondérée).
- [ ] Vérifier le commit réellement servi par Render et la version/build marker exposée par l'application.
- [ ] Ne fusionner/déployer que les changements audités et nécessaires, après contrôle des contrats existants.

**Preuve de clôture :** commit, statut CI, statut PR, build Render et date de vérification consignés ici.

### P0.2 — Reproduire l'estimation réelle du 6 rue Payer-Guillemain
Bien de référence : maison, 150 m² saisis, 6 pièces, DPE D. Le repère affiché dans les captures est de **1 669 €/m², soit 250 350 €**.

- [ ] Capturer la réponse JSON complète de la route réellement appelée par la page.
- [ ] Identifier le champ exact qui alimente les 1 669 €/m² et les 250 350 €.
- [ ] Comparer la valeur affichée avec `calculationTrace.weightedMedianPriceM2`, `weightedMedianSaleId`, `totalWeight` et le prix final calculé.
- [ ] Vérifier le calcul de la fourchette des comparables et distinguer cette fourchette du positionnement vendeur.
- [ ] Vérifier que la donnée affichée correspond au dernier calcul, et non à un cache ou à un résultat d'une autre route.

**Preuve de clôture :** un relevé avant/après comprenant URL de route (sans jeton secret), commit/build, paramètres, champs de sortie et calcul indépendant.

### P0.3 — Déduplication et comptage des ventes
Les captures affichent 288 ventes compatibles, 284 retenues pour le repère DVF et 38 ventes dans l'analyse des caractéristiques. Ces nombres décrivent potentiellement des échantillons différents et doivent être explicitement définis.

- [ ] Relever `sourceCounts`, `duplicateSourceCounts`, `duplicateSourceRows`, `uniqueSourceRows` et `candidateCount`.
- [ ] Vérifier le chevauchement DVF+, ventes du marché et PostgreSQL.
- [ ] Vérifier les empreintes sur date, type, prix, surfaces, adresse/coordonnées et les cas où un champ manque ou varie.
- [ ] Confirmer que le nombre de ventes retenues correspond exactement à la liste `valuationSales`.
- [ ] Expliquer dans l'interface les différences entre ventes reçues, dédoublonnées, admissibles, retenues pour la médiane et utilisées pour les caractéristiques.

**Preuve de clôture :** comptage réconcilié et liste des doublons/exclusions, avec motifs.

### P0.4 — Recalcul indépendant de la médiane pondérée
- [ ] Exporter les ventes de `valuationSales` avec identifiant, date, prix, surface, prix/m² brut et ajusté, score, poids, influence, statut de retenue et motif.
- [ ] Recalculer indépendamment le total des poids et le premier prix/m² dont le cumul atteint 50 %.
- [ ] Vérifier `weightedMedianWinner`, `influencePct` et `weightedMedianSaleId`.
- [ ] Vérifier l'application du contrôle statistique (quartiles/IQR) et les valeurs exclues.
- [ ] Vérifier que les diagnostics et les nombres affichés proviennent du même échantillon.

**Preuve de clôture :** résultat recalculé égal au résultat serveur, ou anomalie documentée avec test de reproduction.

### P0.5 — Sensibilité réelle, sans changer les coefficients
- [ ] Lancer les scénarios déjà prévus dans l'outil d'audit : surface ±10 % et ±20 %, pièces ±1.
- [ ] Tester également les variations de type uniquement si elles restent valides pour le bien.
- [ ] Comparer prix/m², montant total, liste des comparables, poids, médiane gagnante et fourchette.
- [ ] Vérifier le comportement attendu : le montant total doit réagir à la surface; le prix/m² peut rester stable si les comparables retenus et les poids ne changent pas.
- [ ] Expliquer toute stabilité ou variation inattendue avant d'ajuster la formule.

**Preuve de clôture :** tableau de scénarios avec paramètres, résultat, explication et verdict.

### P0.6 — Surfaces et revalorisation temporelle
- [ ] Confirmer que la surface saisie est la surface habitable et que la surface DVF affichée est la surface bâtie; ne pas traiter les deux comme interchangeables.
- [ ] Vérifier le passage de `surfaceBasisComparable` et l'usage du signal d'écart de surface.
- [ ] Vérifier les années, effectifs, médianes et facteurs de `temporalRevaluation`.
- [ ] Conserver 2025 comme année de référence jusqu'à la publication et l'intégration des données DVF 2026.
- [ ] Vérifier qu'aucune vente ne reçoit une correction temporelle double et que les prix bruts restent traçables.

**Preuve de clôture :** une vente exemple recalculée du prix brut au prix ajusté, plus le tableau des années utilisées.

### Porte de sortie P0
Ne passer à la phase suivante que lorsque P0.1 à P0.6 sont documentés. À ce stade, décider explicitement : **VALIDÉ**, **CORRECTION CIBLÉE NÉCESSAIRE** ou **BLOQUÉ PAR LES DONNÉES**. Ne pas relancer une refonte générale.

## P1 — Non-régression de l'application vendeur

- [ ] Tester les pages du parcours vendeur et les liens/boutons, sur ordinateur et mobile.
- [ ] Vérifier les routes API utilisées par chaque page et les champs attendus.
- [ ] Vérifier la continuité du dossier vendeur, le token, la sauvegarde serveur et le secours hors connexion.
- [ ] Vérifier que le repère DVF, la synthèse des caractéristiques, la fourchette et les explications affichent des résultats cohérents.
- [ ] Vérifier les erreurs, états de chargement, absence de données et messages de secours.
- [ ] Vérifier les fonctions de diagnostic sans exposer de secrets ou de jetons.

**Preuve de clôture :** checklist par page, route, action, résultat attendu/réel et statut.

## P2 — Sources de marché et données territoriales

- [ ] Vérifier en production la récupération des données Notaires après les commits déjà consacrés à cette intégration.
- [ ] Vérifier l'import et la couverture territoriale des données INSEE disponibles pour les Ardennes.
- [ ] Vérifier les sources CCI et les autres sources externes : disponibilité réelle, date, périmètre géographique, méthode et message en cas d'échec.
- [ ] Garder les ventes DVF séparées des annonces, indices, données nationales et indicateurs de contexte.
- [ ] Afficher pour chaque source : statut, date de mise à jour, zone couverte et rôle dans l'analyse.
- [ ] Vérifier les données DPE ADEME et le rapprochement d'adresse sans faire échouer le calcul DVF lorsqu'un enrichissement échoue.

**Preuve de clôture :** test réel par source et rapport de couverture, sans inventer de données manquantes.

## P3 — Rédacteur IA et PDF vendeur

- [ ] Vérifier que le texte effectivement rédigé par l'IA est bien celui utilisé dans le PDF.
- [ ] Tester le cas où la clé ou le service IA est indisponible.
- [ ] Afficher un avertissement explicite et un mode de secours identifiable; ne jamais laisser croire qu'un texte IA a été généré si ce n'est pas le cas.
- [ ] Vérifier la cohérence entre les chiffres DVF affichés dans le PDF et ceux du dossier vendeur.
- [ ] Tester la génération et la lisibilité du PDF sur un dossier complet et un dossier incomplet.

**Preuve de clôture :** un PDF de test, son entrée source, son texte final et le résultat du test d'échec IA.

## P4 — Fiabilité opérationnelle et publication

- [ ] Vérifier sauvegarde, restauration possible et continuité de la base PostgreSQL Render existante.
- [ ] Le contexte précédent indiquait une échéance de base au **26 octobre 2026** : vérifier son état actuel, son plan et le risque d'expiration avant cette date.
- [ ] Vérifier les secrets GitHub Actions/Render sans les afficher dans les logs.
- [ ] Exécuter les contrôles CI et tests de non-régression.
- [ ] Déployer seulement après validation P0/P1, puis refaire les tests critiques sur le build en production.
- [ ] Consigner le commit déployé, l'heure, les tests effectués et la décision de publication.

**Preuve de clôture :** déploiement identifié, tests de production passés et plan de continuité de la base confirmé.

## P5 — Finition et critères de livraison

- [ ] Supprimer ou reformuler les messages ambigus et les indicateurs dont le sens n'est pas défini.
- [ ] Vérifier que le vendeur comprend la différence entre repère médian, fourchette des comparables et positionnement indicatif.
- [ ] Vérifier les mentions de limites : la valeur est un repère, pas une promesse de prix de vente.
- [ ] Établir une liste finale des défauts restants, classés bloquants / importants / mineurs.
- [ ] Ne déclarer le projet finalisé qu'après la fermeture des points bloquants et la validation de bout en bout.

## Journal de clôture

| Date | Étape | Résultat / preuve | Statut |
|---|---|---|---|
| 2026-10-11 | Création de la feuille de route | Point de départ commun; aucune modification du moteur déclenchée par ce document | En cours |
| 2026-10-11 | Contrat d'exécution | Responsabilité de suivi, recontrôle et mise à jour explicitement attribuée à l'assistant | Validé |

**Statuts autorisés :** À faire · En cours · Bloqué · Validé · Non applicable.

**Prochaine action unique :** P0.1 — vérifier le commit actif, l'état des PR #12/#13, les contrôles CI et le build réellement servi par Render. Ne pas commencer une nouvelle modification métier avant cette vérification.
