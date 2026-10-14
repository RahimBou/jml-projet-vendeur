# Reconstruction PostgreSQL JML — Contabo

## Objectif
Garder l'application et son architecture de pages. Remettre en place les tables nécessaires sur PostgreSQL Contabo, puis recharger les référentiels publics. Ce document ne suppose pas que la base Render est accessible et ne demande aucune suppression de données.

## Schéma ajouté
Le schéma de référence est `db/schema.sql`. Il est idempotent : `CREATE TABLE IF NOT EXISTS`, aucun `DROP TABLE` et aucune suppression de données.

Tables métier :
- `jml_prospects`, `jml_activities`, `jml_appointment_requests`, `jml_leads`
- `jml_seller_spaces`, `jml_seller_accounts`
- `jml_properties` : biens suivis, distincts des contacts ; aucune unicité sur l'adresse
- `jml_estimation_runs` : entrées et résultats d'estimation pour audit, sans utiliser le prix attendu comme entrée de calcul

Référentiels :
- `jml_dvf_sales` : import DVF standard
- `jml_dvfplus_sales` : import DVF+ Cerema ; conservé séparément pour éviter le double comptage
- `jml_dpe` : DPE/ADEME avec adresse, classes énergie/climat, surface, consommation et émissions
- `jml_bpe_assets` : équipements et services publics INSEE BPE
- `jml_property_listings` : annonces actives et prix affichés, jamais assimilés à des ventes signées

Traçabilité :
- `jml_import_runs` : source, version, dates, compteurs et erreurs d'import.

## Imports déjà présents dans le dépôt
- `scripts/import-dvf.js` : DVF officiel par année, avec contrôles des mutations ambiguës.
- `scripts/import-dvfplus.js` : DVF+ à partir d'un CSV décompressé, filtre département 08 et garde la traçabilité des mutations complexes.
- `scripts/import-bpe.js` : BPE INSEE pour les Ardennes, à partir de `BPE25_Ardennes.csv`.
- Aucun import ADEME/DPE générique n'est encore validé dans ce dépôt : le créer à partir de l'en-tête exact du fichier reçu afin de ne pas mapper incorrectement les colonnes.

## Ordre d'alimentation
1. Contrôler PostgreSQL local sur Contabo et faire un dump de sauvegarde avant toute migration.
2. Appliquer le schéma idempotent.
3. Charger DVF+ Ardennes, vérifier le nombre de lignes, les années, les surfaces et les coordonnées.
4. Charger DPE ADEME, conserver le numéro DPE et la date du diagnostic ; ne pas joindre les DPE aux ventes par la seule adresse.
5. Charger BPE et référentiels adresse/commune.
6. Ajouter les annonces uniquement depuis des sources dont l'accès et les conditions d'utilisation autorisent la collecte ; respecter limites de requêtes, robots/CGU et minimiser les données personnelles.
7. Comparer les résultats DVF et DVF+ pour identifier les doublons avant de les utiliser ensemble dans un calcul.

## Fichiers à fournir, un par un
Pour chaque jeu de données, fournir de préférence l'archive originale ou le CSV/CSV.GZ complet, sans le modifier :
1. `dvfplus_ardennes_residential.csv.gz` (déjà présent dans le dépôt, à réutiliser si valide)
2. Export ADEME DPE existants (département 08 si possible, sinon le fichier national et nous filtrerons)
3. `BPE25_Ardennes.csv` (déjà présent dans le dépôt)
4. Référentiel adresses BAN si nécessaire (sinon utiliser le service/API officiel)
5. Autres fichiers métier (encyclopédie, prix par classe DPE) pour analyse avant import

Ne jamais transmettre de fichier `.env`, de chaîne DATABASE_URL, ni de mot de passe.

## Collecte automatisée des annonces
Le dépôt contient déjà `listing-agent.js` et `estimator-agent.js`. Avant d'augmenter le scraping, auditer leurs routes et résultats. Préférer APIs/flux publics autorisés, enregistrer URL, date de collecte, statut d'extraction et niveau de confiance. Les échecs d'accès, CAPTCHA et champs manquants doivent rester explicites ; ne pas les convertir en « aucune annonce ». Séparer strictement annonces (prix affiché) et DVF (vente signée).
