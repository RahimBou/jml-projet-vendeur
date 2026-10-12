# Développer JML Projet Vendeur avec GitHub Codespaces

Ce guide prépare un environnement de développement isolé. Il ne déploie rien sur Render et ne modifie pas la base de production.

## Ouvrir l'environnement

1. Ouvrir le dépôt : https://github.com/RahimBou/jml-projet-vendeur
2. Sélectionner la branche `setup/codespaces-dev-environment`.
3. Cliquer sur **Code → Codespaces → Create codespace on setup/codespaces-dev-environment**.
4. Attendre l'installation. Le conteneur utilise Node.js 20 et installe les dépendances avec les scripts d'installation désactivés afin d'éviter de télécharger automatiquement Chromium.
5. Pour lancer l'application, il faut d'abord configurer des variables d'environnement de TEST et une base PostgreSQL de TEST. Ne jamais copier les secrets de production dans Codespaces.

## Règles de sécurité

- Ne jamais utiliser l'URL PostgreSQL de production dans l'environnement de développement.
- Ne pas publier de fichier `.env`, de mot de passe, de clé API ou de jeton.
- Faire les changements sur une branche de travail et ouvrir une Pull Request.
- Exécuter les tests et vérifier l'aperçu Web avant de proposer une fusion.
- Ne pas fusionner dans `main`, ni déployer sur Render, sans validation explicite du propriétaire.
- Le port 10000 est prévu pour un aperçu de test ; l'application peut nécessiter des variables d'environnement avant de démarrer correctement.

## Déploiement Render

Le déploiement reste indépendant de Codespaces. Avant de connecter un déploiement automatique à une branche, vérifier la configuration actuelle du service Render. Pour le moment, cette préparation ne change ni le service Render, ni le domaine, ni la base de données.
