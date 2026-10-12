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
