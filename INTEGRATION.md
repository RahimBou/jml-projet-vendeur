# Intégration JML Projet Vendeur — Encyclopédie immobilière

Ce paquet contient :
- `encyclopedia.js` : module Express de recherche en lecture seule ;
- `data/encyclopedia.json.gz.b64` : les 91 fiches du CSV, compressées pour limiter la taille du dépôt.

## À appliquer dans `server.js`
1. Ajouter avec les autres `require` :
   `const registerEncyclopediaRoutes = require("./encyclopedia");`
2. Après `app.disable("x-powered-by");`, ajouter :
   `registerEncyclopediaRoutes(app);`

Aucune modification des fonctions de calcul DVF/DVF+ ou DPE n'est requise.

## Routes
- `GET /api/encyclopedia` : catalogue et catégories
- `GET /api/encyclopedia?q=DPE` : recherche texte
- `GET /api/encyclopedia?category=diagnostics&appliesTo=residential`
- `GET /api/encyclopedia/:slug` : fiche unique

Le fichier d'origine ne contient pas les corps complets des articles, les mots-clés ni les URL des sources. Les définitions restent explicatives et ne doivent jamais être utilisées seules pour appliquer une décote de prix.
