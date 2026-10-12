# Plan de fusion — JML Immobilier unifié

Date : 12 octobre 2026  
Branche de travail : `integration/jml-immobilier-unifie`  
Dépôts sources conservés : `RahimBou/jml-prospection` et `RahimBou/jml-projet-vendeur`

## Règles de sécurité

- Travail réalisé sur une branche dédiée ; ne pas fusionner dans `main` avant validation.
- Ne pas supprimer, écraser ou migrer une base réelle sans sauvegarde vérifiée et comparaison des volumes.
- Ne pas modifier les services Render ou les DNS pendant le développement.
- Ne pas exposer de secrets dans GitHub, les journaux ou les réponses API.
- Un commit, une CI verte et un déploiement sont trois états distincts.
- Le serveur OVHcloud n'est pas considéré comme prêt tant que l'utilisateur n'a pas confirmé la commande et que l'accès SSH n'a pas été vérifié.
- Les valeurs d'estimation ne changent pas pendant la seule phase d'intégration de l'interface.

## 1. Inventaire initial des capacités visibles dans les dépôts

### JML Prospection — dépôt `jml-prospection`

Base technique : Node.js, serveur HTTP natif (`server.js`), interface HTML/CSS/JavaScript, aucun framework backend déclaré dans `package.json`. La version du paquet est 1.50.0 alors que le README documente des fonctionnalités jusqu'à V1.72.0 et le serveur annonce 1.72.1 : versionnage à normaliser.

Fonctions identifiées dans le code et la documentation :
- Radar immobilier Ardennes, recherche par commune/adresse et secteurs multi-villes.
- Sources DVF, DVF+ en ligne, DPE ADEME, BAN/Géoplateforme et BDNB.
- Veille d'annonces, connecteur ChercherTrouver et adaptateur LeBonCoin conditionné aux accès autorisés.
- Rapprochement technique annonce/adresse candidate/DPE/DVF, avec données géographiques.
- Distinction prospect commercial / bien à surveiller.
- CRM terrain, statuts commerciaux, historique, priorités A/B/C/D et dédoublonnage.
- Sélection des 10 meilleurs prospects, fiche prospect, préparation d'appel et assistant IA.
- Tournée, géocodage, optimisation d'ordre, ouverture Google Maps, marquage visité.
- Traitement de la base, statistiques, connecteurs et PWA.
- Répertoire `jml-prospection-v2` séparé contenant une seconde interface et un second serveur ; ne pas confondre cette V2 avec l'application principale.
- Le code client doit être audité pour distinguer données conservées dans le navigateur (localStorage) et données fournies par l'API. Aucun transfert automatique de ces données n'est présumé.

Tests existants repérés : `tests/leboncoin-source.test.js` et `tests/navigation-contract.test.js`, plus workflows GitHub pour validation, import DVF et tests d'adaptateur. La couverture de l'ensemble des boutons, du CRM persistant et du parcours complet n'est pas encore prouvée.

### JML Projet Vendeur — dépôt `jml-projet-vendeur`

Base technique : Express, PostgreSQL (`pg`), pages dans `public/`, agents et services Node.js, Playwright/Chromium. Version déclarée 1.1.0 dans `package.json`, 1.7.0 dans le README et 3.14.8 dans la constante serveur : versionnage à normaliser.

Fonctions identifiées :
- Site et espace vendeur public, pages de préparation à la vente et guides.
- Espace professionnel et pages de dossiers/biens/secteurs.
- API REST prospects/leads et activités commerciales ; tables documentées `jml_prospects`, `jml_activities`, `jml_leads`.
- Estimation fondée sur DVF/DVF+, comparables, médiane pondérée, quartiles/fourchette, revalorisation temporelle et repères externes.
- Contrôles qualité DVF et synthèses annuelles DVF+.
- DPE/ADEME, RNB, géocodage, données de contexte territorial et intelligence de marché.
- Agent d'estimateurs externes avec Playwright et agent de collecte de comparables d'annonces.
- Encyclopédie/lexique immobilier.
- Google Calendar, événements publics, suivi d'acquisition Facebook et de campagnes.
- JML Publication, lead magnet avec consentement, relances, KPI et intelligence commerciale.
- Imports et workflows de données DVF, DVF+ et BPE.
- Pages dédiées au diagnostic DVF, au bien vendeur, au calendrier, au secteur et aux conseils.

Les tables DVF citées par le code comprennent notamment `jml_dvf_sales` et `jml_dvfplus_sales`. Les tables exactes, colonnes, clés, index, migrations et volumes doivent être relevés avant de concevoir une migration. Le fait que deux applications utilisent un nom de table similaire ne signifie pas que leurs schémas ou données sont compatibles.

## 2. Architecture cible proposée

Application canonique : le dépôt `jml-projet-vendeur`, car il possède déjà Express, PostgreSQL, des routes professionnelles et un ensemble de pages. L'interface et les fonctions utiles de Prospection seront intégrées progressivement ; la logique métier ne sera pas copiée aveuglément.

- Une application web et un seul menu professionnel.
- Un backend Express modulaire et une API versionnée.
- Une base PostgreSQL avec migrations réversibles et séparation des domaines.
- Les pages publiques destinées aux vendeurs restent séparées des routes privées de l'espace professionnel par contrôle d'accès.
- Le moteur d'estimation est un service unique appelé par toutes les pages ; aucun écran ne doit recalculer sa propre valeur.
- Les connecteurs de données restent isolés par source et exposent la provenance, la date de collecte, la qualité et le statut d'échec.
- Les annonces actives ne sont jamais mélangées aux ventes DVF signées.
- Le prix envisagé par le propriétaire est stocké séparément et n'entre jamais dans les entrées du calcul automatique.
- Les biens à surveiller restent distincts des prospects commerciaux jusqu'à présence d'un signal commercial vérifié.
- Le déploiement sur OVHcloud attend la disponibilité réelle du VPS, les sauvegardes vérifiées et la validation fonctionnelle.

## 3. Menu unique cible

1. **Accueil** — actions du jour, relances en retard, dossiers prioritaires.
2. **Radar immobilier** — recherche territoriale, ventes DVF/DVF+, DPE et biens à surveiller.
3. **Prospects** — CRM, priorités, historique, appels et relances.
4. **Veille des annonces** — sources autorisées, nouvelles annonces et rapprochements.
5. **Ma tournée** — sélection, ordre de passage, carte et visites.
6. **Estimations** — dossier de bien, comparables, trace de calcul, fourchette et fiabilité.
7. **Dossiers vendeurs** — biens, documents, synthèses, événements et espace client.
8. **Marché** — tendances communales, statistiques DVF et contexte territorial.
9. **Assistant JML** — préparation d'appels, comptes-rendus et relances assistées.
10. **Publication & acquisition** — campagnes, lead magnet et publications, selon les fonctions actuellement opérationnelles.
11. **Réglages & qualité des données** — intégrations, imports, contrôles, utilisateurs et journal d'audit.

Le menu final sera ajusté après inspection des routes et des boutons réellement utilisés ; une fonction incomplète ne sera pas affichée comme opérationnelle.

## 4. Modèle de données canonique à concevoir

Entités candidates, à confronter aux schémas réels :
- `contacts` : propriétaire/contact, coordonnées, consentements et préférences de contact.
- `properties` : bien, adresse normalisée, commune INSEE, coordonnées avec précision, surfaces distinctes, type, pièces, DPE.
- `prospect_cases` : statut commercial, priorité, source du signal, responsable et prochaines actions.
- `activities` : appels, visites, notes, relances et historique.
- `valuations` et `valuation_runs` : résultats, version du moteur, entrées, comparables retenus/exclus, poids, calculs intermédiaires et explications.
- `transactions_dvf` : ventes signées, provenance et identifiant de mutation.
- `listing_observations` : annonces et prix affichés, séparés des transactions.
- `source_records` : provenance, date, statut d'extraction, confiance et identifiants externes.
- `documents`, `campaigns`, `calendar_events` selon l'audit détaillé des tables existantes.

La fusion doit d'abord créer une table de correspondance et une migration d'essai, avec détection des collisions et rapport avant/après. Pas de suppression destructive. Les identifiants et historiques existants doivent être conservés ou mappés de façon reproductible.

## 5. Phases, critères d'acceptation et statut

### Phase 1 — Audit et inventaire
Statut : **audit initial effectué ; audit détaillé encore en cours**.
- Compléter la liste des routes API, appels frontend, boutons, tables, index, variables d'environnement, tâches planifiées et fichiers de données.
- Ajouter une matrice fonction → fichier/route → dépendance → test → état réel.
- Distinguer fonctions documentées, présentes dans le code, testées et validées en production.

### Phase 2 — Menu et architecture
- Créer le shell unifié sur cette branche, sans supprimer les anciennes pages.
- Vérifier tous les liens de navigation et la séparation public/professionnel.
- Critère : aucune page fonctionnelle existante perdue ; routes et responsabilités documentées.

### Phase 3 — Données et services
- Cartographier les schémas PostgreSQL et les données navigateur.
- Construire une migration idempotente et un rapport de rapprochement/doublons.
- Unifier le registre prospects/biens/activités et les contrats API.
- Critère : volumes avant/après explicables, aucune suppression silencieuse, rollback de migration documenté.

### Phase 4 — Réintégration progressive
Ordre proposé : CRM et historique ; Radar/sources publiques ; veille annonces ; tournées ; estimation commune ; intelligence de marché/encyclopédie ; calendrier, publication et acquisition.
Chaque module doit être intégré et testé isolément avant le suivant.

### Phase 5 — Tests
- Syntaxe Node.js et dépendances reproductibles.
- Tests unitaires des calculs, surfaces, types, distances, dates, valeurs atypiques et données manquantes.
- Tests de contrats API et d'accès public/professionnel.
- Tests de navigation, de chaque bouton, formulaires, actualisation et retours d'erreur.
- Tests d'estimation de référence et de sensibilité ; le prix propriétaire ne doit jamais influencer le calcul.
- Tests de déduplication DVF/DVF+ et séparation vente/annonce.
- Tests d'import, persistance PostgreSQL, sauvegarde/restauration et health-check.
- CI verte obligatoire avant toute promotion.

### Phase 6 — OVHcloud et retour arrière
- Ne commencer qu'après confirmation que le VPS est commandé et accessible.
- Installer et sécuriser Ubuntu, Docker/Compose, reverse proxy HTTPS et PostgreSQL persistant.
- Garder les secrets hors du dépôt ; sauvegarder la base avant migration.
- Déployer un environnement de test, restaurer une copie des données, exécuter les tests et comparer les résultats.
- Le déploiement automatique ne se déclenche qu'après CI réussie ; health-check post-déploiement obligatoire.
- Conserver l'image/version précédente et la procédure de rollback ; restaurer la base seulement selon une procédure validée.
- Ne basculer DNS et trafic qu'après validation explicite de l'environnement cible. Conserver l'ancien hébergement jusqu'à validation complète.

## 6. Risques prioritaires constatés

1. Versions divergentes entre paquet, README et serveur dans les deux dépôts.
2. Deux modèles de persistance : backend PostgreSQL dans Projet Vendeur et présence de données de prospection côté navigateur/API à clarifier.
3. Plusieurs versions/serveurs de Prospection dans un même dépôt, dont `jml-prospection-v2`.
4. Moteur d'estimation riche et sensible : conserver les règles métier, la provenance et les tests avant extraction.
5. Tables de prospects potentiellement homonymes mais incompatibles.
6. Import DVF+ compressé et assets volumineux : mesurer le stockage réel, ne pas inclure inutilement de gros fichiers dans les images Docker.
7. Dépendances externes et secrets pour Google Calendar, Gemini, portails d'annonces et emails.
8. Configurations Render existantes avec `autoDeploy: true` : ne pas confondre CI et garde-fou de production ; ne pas les modifier durant l'audit.
9. Tests existants encore insuffisants pour certifier tous les parcours et boutons.
10. L'accès réel au VPS et l'état de la commande ne sont pas encore confirmés.

## Prochaine action précise

Finir la cartographie exhaustive des routes, tables, variables d'environnement et tests ; publier le rapport sur cette branche. Ensuite, créer les tests de caractérisation et seulement après commencer le shell de navigation unifié.
