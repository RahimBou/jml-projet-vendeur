# Installation autonome JML sur Contabo (Ubuntu 24.04)

Cette procédure installe l'application sur le VPS lui-même. Render, GitHub Actions et le dépôt distant ne sont pas requis pour l'exécution quotidienne une fois les fichiers copiés sur le serveur.

## Ce que le script installe
- Node.js 20+ (Node.js 22 LTS si nécessaire), npm, Nginx et PostgreSQL.
- Une base neuve jml_projet_vendeur et un rôle local jml_app.
- Le schéma PostgreSQL livré dans db/schema.sql.
- L'application copiée sous /opt/jml-projet-vendeur.
- Un service systemd et un proxy Nginx local vers le port 10000.

Le script effectue des contrôles préalables, refuse d'écraser un répertoire ou une configuration JML existante, et refuse de réutiliser un rôle ou une base PostgreSQL de même nom. Il vérifie la syntaxe Node.js, la présence des dépendances essentielles, la configuration Nginx, la réponse HTTP de l'application, la connexion PostgreSQL et le message d'initialisation de la base avant d'annoncer le succès. En cas d'échec, il affiche l'état du service et les journaux pour diagnostic; ne pas relancer aveuglément après un échec, car l'installation peut avoir commencé. Il n'installe pas les données historiques DVF/DVF+ : celles-ci doivent être importées ensuite, avec des contrôles distincts.

## Préparer les fichiers après réinstallation du VPS

1. Dans GitHub, ouvrir le dépôt RahimBou/jml-projet-vendeur sur la branche maintenance/contabo-clean-reset-audit.
2. Télécharger l'archive ZIP de cette branche et transférer l'archive sur le VPS, ou utiliser un poste de travail pour la décompresser et envoyer le dossier complet par SCP.
3. Décompresser sous /root/jml-projet-vendeur. Le dossier doit contenir server.js, package.json, db/schema.sql, public/ et les modules JS racine.
4. Exécuter :
   cd /root/jml-projet-vendeur/deploy/contabo
   bash install.sh

L'accès GitHub est utilisé une seule fois pour obtenir le code source initial. Le service en production utilise ensuite sa copie locale et démarre via systemd.

## Contrôle de réussite obligatoire

L'installation n'est considérée réussie que si le script termine sans erreur et affiche « INSTALLATION LOCALE VALIDÉE ». Si le script s'arrête, conserve le message d'erreur complet et inspecte les journaux avant toute nouvelle tentative. Ne supprime aucune base ou aucun dossier pour forcer une relance.

## Après l'installation

Vérifier :
   systemctl status jml-projet-vendeur --no-pager
   curl -fsS http://127.0.0.1:10000/health
   curl -I http://127.0.0.1/
   journalctl -u jml-projet-vendeur -n 100 --no-pager

Les mots de passe générés sont sauvegardés en mode root uniquement dans :
- /root/jml-projet-vendeur-db-password.txt
- /root/jml-projet-vendeur-admin-password.txt

Ne pas les copier dans un dépôt Git, une capture publique ou un message. Enregistrer une copie dans un gestionnaire de mots de passe.

## Domaine et HTTPS

Le Nginx livré ici répond en HTTP pour jml.immo et www.jml.immo. Avant d'activer HTTPS, confirmer que les enregistrements DNS A/AAAA pointent vers l'IP publique actuelle du VPS. Ne pas modifier jml-immobilier.fr. Lorsque le DNS est confirmé, installer Certbot puis obtenir le certificat pour les seuls noms validés.

## Import DVF/DVF+

Ne pas mélanger les sources :
- DVF standard dans jml_dvf_sales.
- DVF+ Cerema dans jml_dvfplus_sales.

Après l'installation, vérifier les scripts d'import présents dans scripts/, leur format source et leur logique de déduplication avant de lancer des imports. Ne pas importer les deux sources dans une même table ni additionner leurs volumes comme s'il s'agissait de ventes différentes.

## Limites connues à régler avant une mise en production publique

- L'application contient des intégrations à des API externes (par exemple données publiques et certains services facultatifs). Cette installation retire la dépendance d'hébergement à Render/GitHub, mais ne rend pas automatiquement chaque fonctionnalité indépendante d'Internet.
- La configuration Nginx démarre en HTTP. HTTPS est une étape séparée après validation DNS.
- Les données DVF, DVF+ et DPE ne sont pas fournies intégralement dans ce kit; elles doivent être importées après tests de qualité.
- Cette installation ne déploie aucune mise à jour automatique depuis GitHub.
