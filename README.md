# Sillage pour Cloudflare Workers

Sillage est une messagerie web autonome. L’accueil est accessible à la racine du site, le compte et le tutoriel sont dans `/connexion`, et la messagerie dans `/messagerie`. Les utilisateurs s’inscrivent avec un pseudo et un mot de passe, puis s’invitent par pseudo. Les comptes et les anciens salons Matrix ne sont pas importés.

Le Worker sert l’interface **et** l’API sur la même adresse. Le déploiement se fait donc dans **Cloudflare Workers & Pages → Workers**, avec un seul Worker. Publier uniquement les fichiers de `dist/` dans Pages afficherait les écrans, mais ne fournirait pas les comptes ni la messagerie.

## Publier sur Cloudflare

Prérequis : un compte Cloudflare et Node.js 22.12 ou plus récent. Ouvre un terminal dans le dossier décompressé, à côté de `wrangler.jsonc`.

```sh
npm ci
npx wrangler login
npm run deploy
```

La commande `npm run deploy` compile l’interface, publie les pages et le Worker, et crée son Durable Object SQLite via la migration `v1`. Wrangler affiche l’adresse HTTPS finale. Si Cloudflare demande un sous-domaine `workers.dev`, définis-le dans le tableau de bord. Pour garder l’accès aux clés locales, utilise l’adresse définitive avant de créer des comptes.

### Déploiement automatique depuis GitHub

Dans **Workers & Pages → ton Worker → Settings → Build**, configure les commandes Workers Builds ainsi :

- **Build command** : `npm run build`
- **Deploy command** : `npx wrangler deploy`

Le build crée le dossier `dist/` attendu par `wrangler.jsonc`. Sans **Build command**, le déploiement échoue avec une erreur indiquant que `dist` n’existe pas. Après avoir enregistré ces réglages, relance le build échoué ou pousse un nouveau commit.

Aucune clé API ne doit être ajoutée au code. Les inscriptions sont ouvertes et limitées côté serveur. Le projet utilise une seule base SQLite Durable Object et des WebSockets. Il fonctionne sans R2, D1, base externe ou serveur à installer. Sur Cloudflare Free, les quotas de la plateforme s’appliquent.

## Tester sur ton ordinateur

```sh
npm ci
npm run build
npm run dev
```

Ouvre l’adresse indiquée par Wrangler. Pour échanger des messages, crée deux comptes dans deux profils de navigateur séparés et ouvre une conversation privée avec le pseudo du deuxième compte. Chaque compte utilise son propre stockage de clés. Une invitation à un salon ajoute aussi le destinataire à sa communauté. Les salons peuvent accueillir jusqu’à 24 personnes.

## Sécurité et limites actuelles

- `ts-mls` implémente le standard MLS (RFC 9420). Les messages des conversations privées et des salons sont chiffrés et signés dans le navigateur. Le serveur reçoit le texte chiffré. Les états de groupe restent dans IndexedDB.
- Chaque fichier est chiffré dans le navigateur avec une clé AES-GCM aléatoire. Sa clé, son nom et ses autres informations passent dans un message MLS. SQLite contient uniquement les octets chiffrés du fichier. La limite est de 1 000 Kio par fichier et 100 fichiers par compte. Cette configuration tient dans les limites des enregistrements SQLite sans activer un service de stockage séparé.
- La clé publique d’un compte est épinglée à sa première découverte. Pour ce premier contact, le prototype fait confiance à l’annuaire du service. La clé publique est visible dans le profil, mais il n’y a pas encore de parcours de vérification mutuelle des contacts.
- Un seul navigateur par compte. Les clés, les messages déjà déchiffrés et les clés des fichiers reçus restent dans les données locales de ce navigateur, y compris après déconnexion. L’effacement des données, un autre navigateur ou un changement d’adresse du site empêchent la récupération. Il n’y a pas de synchronisation d’appareils ni de récupération de compte.
- Le service voit certaines métadonnées, notamment les pseudos, les membres, les noms des salons et les horaires. L’application web et les données locales doivent rester sur une origine et un appareil de confiance. Seuls les comptes du même déploiement peuvent communiquer.
- Prototype testé localement, sans audit de sécurité indépendant. Aucun déploiement sur le compte Cloudflare du propriétaire n’a été effectué.

## Structure

- `src/pages.tsx` — accueil, compte et tutoriel.
- `src/main.tsx` et `src/style.css` — navigation et interface.
- `src/crypto.ts` et `src/storage.ts` — chiffrement et stockage local.
- `worker/index.ts` — comptes, salons, WebSockets et stockage du contenu chiffré.
- `wrangler.jsonc` — configuration Cloudflare.
