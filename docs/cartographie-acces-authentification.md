# Cartographie initiale des accès — JML Immobilier unifié

Date : 12 octobre 2026  
Branche : `integration/jml-immobilier-unifie`  
Statut : première passe statique, à compléter avant de considérer la couverture exhaustive.

## Principes obligatoires

- Toute route est privée par défaut, sauf autorisation publique explicitement documentée.
- L'interface ne constitue jamais une barrière de sécurité : les contrôles sont côté serveur, sur chaque API.
- Les rôles sont issus d'une session serveur vérifiée, jamais d'un champ envoyé par le navigateur.
- Les accès vendeur sont limités à l'identité vendeur issue de la session ; aucun identifiant libre ne peut élargir ce périmètre.
- Les routes professionnelles et d'administration sont interdites au rôle vendeur.
- Les pages privées et réponses contenant des données personnelles doivent utiliser `Cache-Control: no-store`.
- La cartographie est terminée seulement après inspection de toutes les routes `app.get/post/put/patch/delete`, des routeurs enregistrés et des appels frontend.

## Routes explicitement repérées

| Route / famille | Usage repéré | Classe provisoire | Vérification requise |
|---|---|---|---|
| `GET /health` | Santé/version du service | Publique technique | Ne jamais exposer de secret ni de donnée métier |
| `GET /` | Page de connexion professionnelle | Publique | Vérifier le parcours de connexion et les erreurs génériques |
| `GET /projet-vendeur` | Site vendeur public | Publique | Vérifier que les API appelées ne divulguent aucune donnée privée |
| `GET /facebook` | Redirection vers le site vendeur | Publique | Vérifier la conservation des paramètres sans redirection externe |
| `GET /espace-vendeur/:token` | Page vendeur par jeton | Vendeur, accès à vérifier | Jeton aléatoire, expirant, révocable et vérifié côté serveur ; pas de jeton permanent |
| `GET /vendeur-secteur` et `.html` | Page secteur vendeur | À classifier selon données servies | Confirmer si la page est publique ou liée à une session pro |
| `GET /espace-pro` | Entrée espace professionnel | Professionnelle | Actuellement contrôlée par l'ancien contrôle administrateur |
| `GET /index.html` | Interface professionnelle historique | Professionnelle | Contrôler également tous les fichiers/API chargés par la page |
| `/api/*` | API métier et données | Privée par défaut | Inventaire exhaustif et test route par route |
| Routes Google Calendar | Calendrier professionnel | Professionnelle | Revoir les contrôles transmis au routeur et les droits sur chaque action |
| Routes événements publics | Événements/lead acquisition | À classifier endpoint par endpoint | Autoriser seulement les opérations publiques nécessaires |

## Constat d'authentification existante

Le serveur utilise actuellement un cookie `jml_admin_session` HttpOnly et SameSite Strict, avec Secure lorsque la requête est reconnue HTTPS. Cependant, le jeton professionnel est calculé à partir d'une date d'expiration et d'un HMAC basé sur le mot de passe administrateur. Ce n'est pas une session serveur opaque et révocable individuellement.

Le code comporte aussi des limites de tentatives en mémoire. Elles ne sont pas suffisantes comme mécanisme unique dans un environnement multi-instance ou après redémarrage.

Une nouvelle architecture doit remplacer progressivement ce mécanisme par :
- un identifiant de session cryptographiquement aléatoire ;
- uniquement son empreinte stockée côté serveur ;
- expiration absolue et expiration d'inactivité ;
- révocation effective à la déconnexion et lors d'une action de sécurité ;
- rotation de session après authentification ;
- rôle et identifiant vendeur associés à la session côté serveur ;
- limitation des tentatives robuste et indépendante du processus ;
- hachage de mot de passe avec Argon2id (ou bcrypt configuré explicitement) ;
- jetons vendeur stockés sous forme hachée, expirables et révocables ;
- protection CSRF des requêtes mutantes authentifiées par cookie.

## Séquence de mise en œuvre

1. Finir l'inventaire de toutes les routes API et des routeurs externes enregistrés.
2. Ajouter des tests de caractérisation des accès actuels pour éviter de casser les parcours publics.
3. Définir le stockage de sessions et la résolution d'identité vendeur à partir de la base.
4. Implémenter les helpers centraux d'authentification/autorisation et les tester isolément.
5. Brancher les contrôles sur les routes professionnelles, puis vendeur, sans changer les styles des pages.
6. Tester explicitement l'isolation vendeur A/vendeur B et les refus d'accès professionnel.
7. Supprimer l'ancien mécanisme seulement lorsque toutes les routes qui en dépendent ont été migrées et que les tests passent.

## Limites de cette première passe

Ce document n'affirme pas que toutes les routes ont déjà été recensées ni que l'authentification est corrigée. Les fonctions enregistrées dans `events.js`, `google-calendar.js`, `encyclopedia.js` et les autres modules doivent être auditées séparément. Aucune modification de production n'a été faite.

## Constats supplémentaires après inspection du serveur

Ces constats proviennent de la lecture de `server.js` sur la branche d'intégration. Ils ne signifient pas qu'un correctif est déjà actif.

### Priorité critique — accès vendeur

- Les routes `GET /api/seller-space/:token`, `PATCH /api/seller-space/:token` et `POST /api/seller-space/:token/estimator-agent` recherchent directement l'espace à partir du jeton présent dans l'URL. Elles ne vérifient pas la session vendeur `jml_seller_session`.
- Le jeton d'espace vendeur sert donc à la fois d'identifiant et de capacité d'accès. Il est aléatoire, mais il reste durable et n'est pas révocable par une vraie gestion de sessions centralisée dans le flux inspecté.
- Les sessions vendeur actuelles sont stockées dans une `Map` du processus Node.js, expirent après 30 jours et ne survivent ni au redémarrage ni au changement d'instance. Elles ne sont pas les sessions PostgreSQL du nouveau module `auth.js`.
- L'inscription d'un compte vendeur associe l'adresse e-mail au prospect lié, mais le compte ne protège pas encore les routes d'accès à l'espace. La connexion établit une session en mémoire, sans que les routes espace la contrôlent.
- Les routes d'inscription, de connexion et Google doivent être revues pour éviter les abus, la création de comptes non autorisée et les sessions non persistantes.

**Conséquence :** le nouveau module `auth.js` ne doit pas être activé seul ni présenté comme une protection effective. Il faut concevoir et tester une migration des liens vendeur vers des sessions vérifiées, avec une période de transition maîtrisée pour ne pas casser les parcours existants.

### Priorité élevée — accès professionnel

- L'espace professionnel utilise encore `jml_admin_session`, un jeton HMAC dérivé du mot de passe administrateur et d'une expiration. Il n'est pas stocké côté serveur et ne peut pas être révoqué individuellement.
- Les protections professionnelles sont répétées dans les handlers avec `requireAdminOr401`. Il faut recenser toutes les routes et modules avant de remplacer ce contrôle, afin de ne pas laisser de route oubliée ni bloquer les fonctions publiques légitimes.
- `GET /api/admin/diagnostics/gemini` applique une limite de tentatives, mais l'extrait inspecté ne montre pas de contrôle professionnel explicite au début de ce handler : il doit être confirmé et classé avant le déploiement.
- Le serveur accepte un mode sans PostgreSQL et plusieurs fonctions utilisent alors des cartes en mémoire. Le nouveau système d'authentification persistant doit refuser les accès privés si la base n'est pas disponible, et non retomber silencieusement sur une session mémoire.

### Ordre de correction proposé

1. Ajouter une protection de connexion persistante pour l'espace professionnel sans modifier la page de connexion.
2. Introduire des tests d'autorisation pour toutes les routes professionnelles et les routes publiques conservées.
3. Mettre en place l'association entre une session vendeur vérifiée et l'espace autorisé côté serveur ; supprimer progressivement l'accès direct par jeton durable.
4. Ajouter les tests d'isolation vendeur A/vendeur B, de révocation, d'expiration, d'absence de base et de CSRF avant d'activer la migration.
5. Déployer uniquement après résultats CI verts et revue des routes/modules ; aucun déploiement n'est effectué par ce changement.



## Correctifs appliqués après cette inspection

- `GET /api/admin/diagnostics/gemini` vérifie désormais `requireAdminOr401` avant de lancer un diagnostic externe. Une personne non authentifiée ne peut plus utiliser cette route comme endpoint de diagnostic public.
- `GET /api/health` ne renvoie plus le message brut d'erreur PostgreSQL, ni l'indicateur de configuration du mot de passe administrateur, ni les détails de secteur. La réponse est minimale et marquée `Cache-Control: no-store`.
- Le workflow CI est déclenché sur les push de `main` et de `integration/jml-immobilier-unifie`, en plus des événements de pull request, pour que les prochains commits de la branche de fusion puissent être contrôlés directement.

Ces changements sont sur la branche d'intégration uniquement. Le dernier run CI confirmé vert a exécuté `npm install`, les vérifications de syntaxe et `npm test` sur le commit `193a3f4`. Les correctifs de sécurité postérieurs doivent encore obtenir leur propre résultat CI avant d'être considérés comme validés.

## Prochaine étape de migration

Le correctif du diagnostic Gemini ne remplace pas la migration d'authentification. Les routes d'espace vendeur restent basées sur le jeton de lien existant afin de ne pas casser les liens envoyés aux propriétaires. Il faut donc migrer explicitement le parcours utilisateur (création/activation de compte, connexion, lien de récupération, accès aux pages et appels API) avant d'exiger partout une session vendeur. Le module `auth.js` reste non raccordé au serveur et ne doit pas être décrit comme actif.
