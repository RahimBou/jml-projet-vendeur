# Inventaire technique détaillé — avant fusion JML Immobilier

Date : 12 octobre 2026  
Sources lues : branche `main` des deux dépôts. Cet inventaire est statique : il décrit les routes et éléments présents dans le code, pas une certification de leur fonctionnement en production.

## Dépôts et versions incohérentes à traiter

| Élément | JML Prospection | JML Projet Vendeur |
|---|---|---|
| Package | `1.50.0`, Node >=20, sans dépendances déclarées | `1.1.0`, Node >=20, Express 4, pg, Playwright, Google Auth |
| README | Fonctions documentées jusqu'à V1.72.0 | Version README 1.7.0 |
| Version serveur | `1.72.1` | `3.14.8` |
| Persistance constatée | Le client utilise `localStorage` pour des éléments de CRM/sélection/tournée ; serveur API de sources | PostgreSQL avec `DATABASE_URL`, migrations de tables au démarrage |
| Serveurs multiples | `server.js` principal et `jml-prospection-v2/server.js` séparé | Un serveur Express principal |
| Tests présents | `leboncoin-source.test.js`, `navigation-contract.test.js` | `scripts/check-inline-html.js`, CI syntaxe ; plusieurs workflows d'import |
| Déploiement actuel déclaré | Plusieurs services Render avec `autoDeploy: true` | Service Node Render avec `autoDeploy: true` |

## JML Prospection — fonctions et routes d'API recensées

### Interface / parcours

- Accueil / cockpit terrain.
- Trouver : radar territorial et recherche avancée.
- Prospects : CRM, filtres de statut, fiche prospect, priorités A/B/C/D, sélection de dossiers.
- Veille annonces ; connecteur LeBonCoin (seulement si flux/API autorisé et configuré).
- Ma tournée : sélection, limite, optimisation géographique, lien itinéraire, marquage visité.
- Traitement des données et secteurs.
- Bilan et statistiques.
- Assistant IA : analyse, préparation d'appel, compte-rendu, relance et priorisation.
- Connecteurs/sources publiques, diagnostics et export/import CSV.
- PWA et seconde application dans `jml-prospection-v2`.

### Routes détectées dans `server.js`

`GET /api/health`, `GET /api/diagnostic`, `GET /api/integrations-health`, `GET /api/data-agent`, `GET /api/geocode`, `GET /api/prospect-match`, `GET /api/estimateur-sources`, `GET /api/address-candidates`, `GET /api/sector-tour`, `GET /api/connectors-sync`, `GET /api/sources-health`, `GET /api/annonces`, `GET /api/veille-annonces`, `GET /api/annonces-multi`, `GET /api/leboncoin/status`, `GET /api/leboncoin/test`, `GET /api/commune`, `GET /api/dpe`, `GET /api/territory`, `GET /api/radar-zone`, `GET /api/radar`, `GET /api/radar-territory`, `GET /api/backtest`, `GET /api/dvf`, `POST /api/ai`.

Les méthodes et réponses de toutes ces routes restent à vérifier individuellement dans les tests de caractérisation ; la liste ci-dessus est un index statique.

### Variables d'environnement recensées

`PORT`, `STREAM_ESTATE_API_KEY`, `CHERCHERTROUVER_API_KEY`, `MOTEURIMMO_API_KEY`, `YANPORT_API_KEY`, `CASAFARI_API_KEY`, `LEBONCOIN_SOURCE_AUTHORIZED`, `LEBONCOIN_FEED_URL`.

Les clés optionnelles non configurées doivent donner un état « non configuré » explicite ; elles ne doivent pas provoquer de fausses annonces ou d'estimations fictives.

### Persistance côté navigateur

Clés statiques observées :
- `jml_prospection_v1`
- `jml_prospection_selection_v1`
- `jml_tour_limit_v1`
- `jmlMarketLastPollV1`

Ces données peuvent être propres à un navigateur et ne sont pas automatiquement présentes sur le serveur. La fusion doit inclure une exportation/importation contrôlée et un chemin de reprise, sans supposer que PostgreSQL contient déjà toutes les fiches.

## JML Projet Vendeur — fonctions et routes recensées

### Pages / modules

- Site public et formulaire de premier repère d'estimation.
- Espace vendeur et espace professionnel.
- Fiches prospects, biens rattachés, statuts, qualification, activités et relances.
- Demandes de rendez-vous, créneaux et confirmation/refus.
- Création/connexion d'espace vendeur, accès par jeton, compte Google.
- Estimation DVF/DVF+, comparables, tendances communales, données territoriales, enrichissement DPE/RNB.
- Agent d'estimation externe Playwright et collecte de comparables d'annonces.
- Contrôle qualité DVF, résumé de marché DVF+, état BPE, diagnostics et pipeline.
- Encyclopédie/lexique, conseils vendeurs, guides et génération de synthèse.
- Intelligence de mandat, idées de publication, acquisition/lead magnet.
- Google Calendar et événements publics.
- Imports programmés DVF/DVF+/historique/BPE.

### Routes principales détectées dans `server.js`

**Santé et diagnostics** : `GET /health`, `GET /api/health`, `GET /api/diagnostic`, `GET /api/pipeline`, `GET /api/bpe-status`, `GET /api/dvfplus-market-summary`, `GET /api/dvf-quality`, `GET /api/territory-version`, `GET /api/admin/diagnostics/gemini`.

**Estimation / territoire** : `GET /api/address-suggest`, `GET /api/rnb/buildings`, `GET /api/immo-data/test`, `GET /api/commune-market`, `GET /api/territory-commune`, `POST /api/estimator-agent/run`, `GET /api/external-market-benchmarks`, `GET /api/territory-comparables`, `GET /api/territory-nearby`, `GET /api/jml-listings`, `GET /api/market-climate`, `POST /api/market-climate/analysis`, `GET /api/territory-summary`, `GET /api/territory-assets`, `GET /api/streetview`, `GET /api/territory-enrichment`, `GET /api/dpe/status`, `GET /api/dpe/import`, `POST /api/seller-guide/synthesis`.

**CRM** : `GET /api/prospects`, `POST /api/prospects`, `PUT /api/prospects/:id`, `PUT /api/prospects/:id/status`, `POST /api/prospects/:id/qualify`, `GET /api/prospects/:id/activities`, `POST /api/prospects/:id/activity`, `PUT /api/prospects/:id/follow-up`, `DELETE /api/prospects/:id`, `GET /api/prospect-properties`, `DELETE /api/prospect-properties/:id`.

**Acquisition / vendeur** : `GET /api/appointment-requests`, `POST /api/appointment-requests/:id/confirm`, `POST /api/appointment-requests/:id/reject`, `GET /api/appointment-slots`, `POST /api/public-appointment`, `POST /api/seller-access`, `POST /api/seller-account/register`, `POST /api/seller-account/login`, `GET /api/seller-account/google/start`, `GET /api/seller-account/google/callback`, `POST /api/seller-account/logout`, `GET /api/seller-space/:token`, `POST /api/seller-space/:token/estimator-agent`, `PATCH /api/seller-space/:token`, `POST /api/leads`, `GET /api/leads`, `GET /api/mandat-intelligence`, `GET /api/seller-advice`, `GET /api/publication-ideas`, `GET /api/public-events`.

**Pages** : `GET /`, `GET /projet-vendeur`, `GET /espace-vendeur/:token`, `GET /facebook`, `GET /espace-pro`, `GET /index.html`, `GET /guide`, plus la distribution des pages statiques.

Les routes Google Calendar sont enregistrées par module : `/api/appointment-requests/:id/accept`, `/api/google-calendar/auth`, `/api/google-calendar/callback`, `/api/google-calendar/disconnect`, `/api/google-calendar/status`, `/api/google-calendar/availability`.

### Tables recensées dans le code

- `jml_prospects`
- `jml_activities`
- `jml_appointment_requests`
- `jml_seller_spaces`
- `jml_leads`
- `jml_bpe_assets`
- `jml_dvf_sales`
- `jml_dpe`
- `jml_seller_accounts`
- `jml_dvfplus_sales` (utilisée par les routes de synthèse ; sa définition doit être retrouvée dans les scripts/imports/migrations)
- `jml_google_calendar_tokens` (initialisée dans le module Google Calendar)

Attention : les activités sont liées à `jml_prospects` avec `ON DELETE CASCADE` et les espaces vendeur peuvent référencer un prospect avec `ON DELETE SET NULL`. La suppression de prospect peut donc avoir des effets sur l'historique ; ne pas importer ou supprimer sans règles de conservation explicites.

### Variables d'environnement recensées

`PORT`, `NODE_ENV`, `DATABASE_URL`, `DATABASE_SSL`, `JML_ADMIN_PASSWORD`, `ADMIN_PASSWORD`, `CURRENT_DATA_YEAR`, `ESTIMATOR_AGENT_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `IMMO_DATA_API_BASE_URL`, `IMMO_DATA_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_MAPS_API_KEY`, `GOOGLE_PLACES_API_KEY`, `GOOGLE_STREETVIEW_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, `WEBSTAT_API_KEY`, `PUBLIC_APP_URL`, `JML_CALENDAR_TOKEN_SECRET` (avec valeurs de repli codées dans certains chemins).

## Contrats et tests à créer avant extraction

- Capturer pour chaque route une réponse type, statut HTTP, authentification requise et dépendances.
- Ajouter des tests API pour le CRM et les biens, y compris le cas de suppression et les références liées.
- Vérifier les appels front-end et l'identifiant de chaque bouton : action attendue, résultat visible, état d'erreur et navigation retour.
- Exporter un échantillon anonymisé du localStorage de Prospection pour concevoir l'adaptateur d'import ; ne pas mettre de données propriétaires réelles dans le dépôt.
- Inspecter les scripts d'import DVF/DVF+ et vérifier les contraintes uniques avant d'unifier les tables.
- Auditer les variables de production sans afficher les secrets ; l'inventaire des noms n'autorise pas à copier les valeurs secrètes dans GitHub.

## Décision provisoire

Le serveur Express/PostgreSQL de Projet Vendeur est le candidat le plus naturel pour devenir le backend canonique. Le moteur Radar et les connecteurs de Prospection seront extraits en modules derrière des contrats stables ; la persistance du CRM navigateur doit être migrée explicitement. Cette décision sera réévaluée seulement si les tests révèlent une contrainte technique bloquante.
