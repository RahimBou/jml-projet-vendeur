# Audit technique et architecture cible — JML Projet Vendeur

Date de l'audit : 10 octobre 2026
Dépôt : RahimBou/jml-projet-vendeur

## Objectif

Unifier la collecte de données immobilières, les ventes DVF/DVF+, les annonces, les repères externes et l'analyse du marché dans une chaîne traçable, réutilisable par les outils JML. DVF reste la base factuelle des ventes enregistrées. Les annonces restent des prix affichés et ne doivent jamais être présentées comme des ventes signées.

## État constaté dans les fichiers examinés

- `server.js` porte les routes HTTP, les contrôles de données et l'orchestration de plusieurs modules métier. Il importe notamment `external-estimators.js`, `market-intelligence.js`, `rnb-buildings.js`, `estimator-agent.js` et `listing-agent.js`.
- PostgreSQL est déjà utilisé, avec au moins les tables `jml_dvf_sales` et `jml_dvfplus_sales` citées dans les routes de contrôle et de synthèse.
- `listing-agent.js` recherche des résultats via Bing, puis tente d'extraire prix/surface/pièces depuis les extraits et les pages des portails. La couverture est limitée à quelques hôtes, l'extraction HTML est heuristique et les requêtes sont séquentielles. Les résultats incomplets ou bloqués ne doivent pas être assimilés à une absence d'annonces.
- `external-estimators.js` contient des appels GeoRegistry DVF par adresse/rue ainsi que des extracteurs d'autres repères. Il faut éviter de compter un repère externe fondé sur DVF comme une source indépendante des transactions DVF de JML.
- `market-intelligence.js` récupère le référentiel communal via geo.api.gouv.fr, mais les contrôles INSEE, CCI et Notaires décrits dans le code vérifient actuellement surtout l'accessibilité HTTP. Le code indique explicitement que les statistiques, tableaux ou PDF ne sont pas extraits par ces contrôles.
- `rnb-buildings.js` fournit un rapprochement de bâtiments et d'adresses ; un bâtiment RNB trouvé n'est pas une preuve d'identité parfaite ni une donnée de propriétaire.
- `estimator-agent.js` pilote des formulaires publics avec Playwright. Les valeurs extraites automatiquement doivent être accompagnées du site, de l'heure, du statut d'extraction et d'un niveau de confiance ; les CAPTCHA, pages inaccessibles et formulaires non remplis doivent être déclarés comme échecs, jamais comme estimations nulles.
- Les versions affichées ne sont pas alignées : package.json 1.1.0, README 1.7.0, constante serveur 3.14.6. Un identifiant de build existe déjà, mais il ne remplace pas une version canonique unique.

## Risques à traiter avant de modifier la formule d'estimation

1. Risque de double comptage : ventes DVF locales, DVF+ et GeoRegistry peuvent représenter les mêmes mutations.
2. Risque de mélange sémantique : prix de vente signé, prix d'annonce et estimation de portail ne sont pas la même mesure.
3. Risque de faux comparables : surface bâtie DVF, surface habitable, terrain et dépendances doivent rester des champs distincts.
4. Risque de biais de sélection : les annonces disponibles en ligne ne représentent pas toutes les transactions ni toutes les offres.
5. Risque de résultats figés : journaliser les entrées, candidats, exclusions, poids, médiane, plancher et résultat final pour pouvoir vérifier la sensibilité de chaque estimation.
6. Risque d'afficher une confiance excessive : le volume brut ne suffit pas ; il faut des ventes proches, récentes, de même type et comparables en surface/caractéristiques.
7. Risque de confusion sur les sources institutionnelles : une page accessible ne signifie pas que des statistiques ont été collectées.
8. Risque juridique et opérationnel : respecter les conditions d'utilisation des sites, les limites de requêtes, les droits sur les contenus, la protection des données personnelles et les règles de consentement pour les leads.

## Architecture cible

```
Sources officielles et partenaires
  ├─ DVF / DVF+ (transactions)
  ├─ DPE / ADEME (diagnostics, avec rapprochement prudent)
  ├─ BAN / geo.api.gouv.fr / RNB (adresse, territoire, bâtiment)
  ├─ INSEE / CCI / Notaires (contexte, seulement si chiffres datés réellement extraits)
  ├─ Portails d'annonces (offres en cours, prix affichés)
  └─ Estimateurs externes (repères secondaires, origine et dépendance documentées)
                  |
                  v
        Adaptateurs de source isolés
                  |
                  v
       Normalisation + validation qualité
                  |
                  v
   Registre commun des biens / mutations / annonces
   - identifiant source et identifiant canonique
   - URL/source, date de collecte et date de l'événement
   - commune INSEE, adresse normalisée, coordonnées et précision
   - type, surface habitable, surface bâtie, terrain, pièces
   - prix, nature du prix, statut et unité
   - qualité, champs manquants, motif d'exclusion
                  |
                  v
       Déduplication et rapprochement explicables
                  |
                  v
       Services métier indépendants
       ├─ sélection des ventes comparables
       ├─ calcul DVF et plancher vendeur
       ├─ repères d'annonces (séparés des ventes)
       ├─ tendance locale et tension du marché
       └─ enrichissement DPE / bâtiment / territoire
                  |
                  v
       API versionnée et contrat de réponse commun
          ├─ Projet Vendeur / dossier vendeur
          ├─ outil de prospection JML
          ├─ tableau de marché vendeur
          └─ autres logiciels JML autorisés
                  |
                  v
       Journal d'audit, métriques, tests et alertes
```

## Règles métier à préserver

- Le prix envisagé par le propriétaire est enregistré séparément et ne doit pas influencer le calcul automatique.
- DVF reste la référence des ventes signées et le plancher de référence demandé pour le vendeur ; ne jamais remplacer ce plancher par une médiane communale ou une estimation de portail.
- Séparer au minimum : plancher DVF, valeur centrale JML, fourchette, prix affichés des annonces et repères externes.
- Comparer uniquement des biens de même catégorie ; ne pas substituer surface bâtie à surface habitable sans règle documentée.
- Chaque comparable doit afficher sa date, sa distance, sa source, ses écarts de surface/type, son statut d'inclusion et son poids.
- Une source non accessible, non extraite ou dont les données sont trop anciennes doit avoir un statut explicite. Ne jamais inventer une valeur manquante.
- Les données de contexte (population, équipements, économie) expliquent le territoire mais ne deviennent pas directement des prix immobiliers.
- Le signal vert/orange/rouge doit inclure la période, le volume, la couverture et les limites, sans promettre qu'une vente est garantie.

## Plan d'exécution recommandé

### Étape 1 — Stabiliser l'existant
- Établir l'inventaire réel des routes, tables, tâches d'import et variables d'environnement.
- Identifier toutes les fonctions qui calculent ou modifient une valeur estimée.
- Relever les doublons, appels externes, seuils, valeurs de repli et caches.
- Aligner version de package, version API, build marker et README.

### Étape 2 — Rendre le calcul entièrement traçable
Pour chaque estimation, enregistrer un identifiant d'exécution, les caractéristiques d'entrée, la date de référence, les candidats trouvés, les candidats rejetés avec raison, les poids appliqués, les statistiques intermédiaires et le résultat final. Masquer le prix propriétaire du calcul.

### Étape 3 — Créer le registre commun sans casser les écrans
- Définir des schémas canoniques distincts pour mutation DVF, annonce et estimation externe.
- Ajouter des adaptateurs et une normalisation commune.
- Dédupliquer à l'import avec des clés déterministes et des règles de rapprochement géographique prudentes.
- Conserver la provenance source et les données brutes nécessaires à l'audit.

### Étape 4 — Unifier les services, pas toutes les données
- Un seul service de sélection/pondération des ventes comparables.
- Un service distinct pour les annonces actives.
- Un service distinct pour la tendance du marché.
- Un service distinct pour les repères externes.
- Les écrans consomment les mêmes contrats API ; aucun écran ne recalcule sa propre estimation.

### Étape 5 — Vérifier avant déploiement
- Tests unitaires sur surfaces, type, date, distance, atypiques et données manquantes.
- Tests de sensibilité : modifier surface, adresse, type ou caractéristiques doit expliquer les changements du résultat.
- Tests anti-double-comptage DVF/DVF+ et contrôle des replis.
- Test de non-régression sur les cas de référence vendeur, dont le cas « 6 rue Payen-Guillemain » déjà signalé.
- Déploiement Render seulement après réussite des tests et vérification de /health et des données de production.

## Critères d'acceptation

- Chaque chiffre affiché indique sa nature : vente signée, prix affiché, estimation externe ou contexte.
- Chaque source affiche un statut d'extraction vérifiable et une date.
- Les candidats trouvés, retenus et rejetés sont comptés séparément.
- Le moteur explique la contribution de chaque comparable et toute valeur de repli.
- Aucun fallback communal ne remplace silencieusement les comparables DVF.
- Une indisponibilité de source ne fait pas tomber l'application entière.
- Les écrans JML partagent les mêmes services métier et contrats API.
- Les tests passent avant de modifier les pondérations en production.

## Limite de cet audit

Ce document est un audit initial des fichiers examinés, pas une certification complète de l'application déployée. Les routes restantes, les schémas SQL de toutes les tables, les workflows d'import et le comportement Render doivent encore être contrôlés. Aucune formule de production n'est déclarée validée tant que les tests de sensibilité et de non-régression ne sont pas exécutés.
