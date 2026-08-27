# Cloud — YunoHost app

Personal file storage with a web interface and a native iOS client. Upload,
browse, preview and share your files.

Every file belongs to one account and lives in that account's own area. Sharing
publishes an item without moving it, so "My Files" is always everything you
have, and "Shared" is only what somebody deliberately published.

Packaged for YunoHost 12, following the same conventions as `wg-man_ynh`.

## What you get

- **Per-user storage** at `/me`. Nothing else on the server holds file bytes.
- **Sharing by reference** at `/shared`. A shared item stays where it is, still
  counts against its owner's quota, is read-only to everyone else, and vanishes
  from Shared the moment it is unshared — nothing is copied or moved.
- **A web interface** — list and icon views, thumbnails for images, videos and
  PDFs, drag-and-drop upload, multi-select with move/copy/share/delete,
  full-screen previews, search, and Recently Deleted.
- **Resumable uploads.** Large files are sent in 8 MB chunks straight to their
  final offset on disk, so an interrupted upload resumes instead of restarting.
- **Passkeys.** Sign in with the fingerprint, face or PIN on your own device.
  The private key never leaves it and the server stores only a public key.
- **A REST API** for native clients, authenticated against YunoHost's LDAP.
- **SSO for the browser.** The portal session is exchanged for a token; nobody
  has to type a password twice.

## Install

```bash
sudo yunohost app install https://github.com/<you>/cloud_ynh
```

You are asked for:

| Question | Default | Notes |
|---|---|---|
| Domain and path | `/cloud` | Where the app is served |
| Permission group | `all_users` | Who may use it |
| Per-user quota (GB) | `0` | 0 means unlimited |
| Largest single upload (GB) | `20` | Rejected before any bytes transfer |
| Sharing | yes | Lets users publish their own items to everyone with access |
| Passkeys | yes | Lets users sign in without a password |
| Thumbnails | yes | Needs `ffmpeg` and `poppler-utils`, installed automatically |

All five can be changed later without reinstalling, from the app's Config panel
or with `yunohost app config set cloud`.

## Where things live

```
/var/www/cloud/              the built app (owned by the cloud system user)
/home/yunohost.app/cloud/
├── users/<username>/        every file, one root per account
└── .meta/
    ├── shares.json          which items are published under /shared
    ├── trash/<username>/    deleted items, kept 30 days
    ├── thumbs/              generated thumbnails, capped at 512 MB
    ├── uploads/             chunks of uploads still in flight
    ├── tokens/              hashed refresh tokens, one file per account
    └── passkeys/            registered passkeys — public keys only
```

There is no shared directory on disk. `/shared` is assembled from
`shares.json`, whose entries point back into their owners' roots.

Only `install_dir` is replaced on upgrade. `data_dir` holds the users' files and
is left alone — and it is removed only when you purge the app.

## How authentication works

Three ways in, one authorisation path.

**The browser** already has a YunoHost portal session. It calls
`/api/sso/session`, which sits behind SSOwat; nginx injects the user's identity
and the API exchanges it for a 15-minute access token. The token is held in
memory and re-minted after a reload, so there is no cookie to steal and no CSRF
surface.

**A passkey** is the second browser route, for people who would rather not go
through the portal — or cannot, because the portal session has expired on a
device they are not signed in to. Registration happens from an
already-authenticated session, so a passkey never bootstraps an identity; it
only adds a second key to one that was already proved. Sign-in uses discoverable
credentials, which means the screen asks for no username and so cannot be used
to find out which accounts exist. The refresh token that comes back is kept in
an `HttpOnly`, `SameSite=Strict` cookie scoped to the auth endpoints, so script
never sees it and no other site can cause it to be sent.

**Native clients** have no portal cookie, so `/api/v1` is registered as a
`visitors` permission — nginx lets it through untouched and the API does the
work. `POST /api/v1/auth/login` binds the given credentials against YunoHost's
LDAP; the bind *is* the password check. On success the account's `memberOf` is
read to confirm it holds the `cloud.main` permission, and a token pair comes
back. Refresh tokens rotate on every use and are stored only as SHA-256
digests, so a copy of the token file is worthless.

Revoking the app permission in the YunoHost admin panel ends existing device
sessions the next time they refresh, rather than thirty days later.

Requests are also required to carry a shared secret that only nginx knows,
which stops another process on the host from calling the API directly on
`127.0.0.1:3010`.

## API

Everything is under `<domain><path>/api/v1`. Send `Authorization: Bearer <token>`.

### Authentication

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/login` | `{username, password, device}` → token pair |
| `POST` | `/auth/refresh` | `{username, refreshToken}` → rotated pair |
| `POST` | `/auth/logout` | Revoke one refresh token |
| `GET` | `/auth/me` | Account, roots, usage, limits |
| `GET` | `/auth/sessions` | Signed-in devices |
| `DELETE` | `/auth/sessions/:id` | Revoke one device |
| `POST` | `/auth/web/session` | Resume a passkey session from its cookie |
| `POST` | `/auth/web/logout` | End it and clear the cookie |
| `POST` | `/auth/passkeys/challenge` | Start a sign-in ceremony |
| `POST` | `/auth/passkeys/login` | Finish it → token pair, or a cookie |
| `POST` | `/auth/passkeys/register/options` | Start enrolling (authenticated) |
| `POST` | `/auth/passkeys/register` | Finish enrolling |
| `GET` | `/auth/passkeys` | Registered passkeys |
| `PATCH` | `/auth/passkeys/:id` | Rename one |
| `DELETE` | `/auth/passkeys/:id` | Remove one |

### Files

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/files/?path=&sort=&desc=` | List a folder, with a read ticket |
| `GET` | `/files/stat?path=` | One entry |
| `GET` | `/files/search?q=&path=` | Recursive filename search |
| `POST` | `/files/folder` | `{path}` |
| `POST` | `/files/rename` | `{path, name, conflict}` |
| `POST` | `/files/move` | `{from, to, conflict}` |
| `POST` | `/files/copy` | `{from, to, conflict}` |
| `POST` | `/files/ticket` | `{path}` → read ticket for a subtree |
| `GET` | `/files/shares` | What you have published |
| `POST` | `/files/share` | `{path}` → publish one of your items |
| `DELETE` | `/files/share?path=` | Stop publishing it |
| `DELETE` | `/files/?path=&permanent=` | To Recently Deleted, or for good |

A listing also carries `writable`, and each entry may carry `shared`,
`sharedAs`, `sharedBy` and `readOnly` — enough for a client to know what it may
offer before the user tries it.

### Bytes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/media/download?path=` | Full file, supports `Range` |
| `GET` | `/media/preview?path=` | Inline, sandboxed, images/video/audio/PDF only |
| `GET` | `/media/thumb?path=&size=` | JPEG thumbnail (128/256/512/1024) |

These three also accept `&t=<ticket>` instead of a bearer token, for `<img>`
tags and anything else that fetches a URL without letting you set a header. A
ticket is read-only, scoped to one subtree, and lasts fifteen minutes.

### Uploads

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/upload/simple?path=` | Multipart, one request, up to 64 MB |
| `POST` | `/upload` | `{path, size, mtime, conflict}` → session |
| `GET` | `/upload/:id` | Which chunks are still missing |
| `PUT` | `/upload/:id/chunk/:index` | Raw bytes of one chunk |
| `POST` | `/upload/:id/complete` | Finalise |
| `DELETE` | `/upload/:id` | Abandon |

### Trash and sync

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/trash/` | Deleted items and the retention window |
| `POST` | `/trash/:id/restore` | Put back |
| `DELETE` | `/trash/:id` | Delete for good |
| `DELETE` | `/trash/` | Empty |
| `GET` | `/sync/changes?root=&since=` | Entries modified since an anchor |

Paths are virtual: `/me/Documents/report.pdf`, `/shared/Holiday Photos/beach.jpg`.
The first segment names a root, so a device that signs in as somebody else sees
the right files without rewriting anything it cached. Under `/shared` the second
segment names a published item and everything after it resolves inside the
owner's own directory — the same bytes, reached from a different angle.

## Development

```bash
npm install && npm install --prefix server
cp server/.env.example server/.env
npm run dev          # Vite on :5173, API on :3010
```

Outside production the API skips LDAP and attributes every request to
`DEV_USER`. That is also why the server refuses to start in production without
`PROXY_SECRET` and `JWT_SECRET` — those are what turn the shortcut off.

```bash
npm run typecheck --prefix server
npm run build
```

## Design notes

**Why virtual paths and not IDs.** There is no database. The filesystem is the
source of truth, which means a restored backup, an `rsync`, or a file dropped in
over SSH all just work. The cost is that renaming changes an item's identity —
acceptable for a personal drive, and much cheaper than an index that has to stay
consistent with everything else that might touch the directory.

**Why chunks go to their final offset.** The upload session preallocates a
sparse file the size of the finished upload and writes each chunk where it
belongs. Chunks can then arrive out of order or in parallel, a resumed upload
only sends what is missing, and completing is a `rename` rather than a second
pass over the bytes.

**Why every path is resolved twice.** Normalising a client's path is not enough:
a symlink inside the data directory would let a request read anywhere the
service user can reach. Every access canonicalises the nearest existing ancestor
and checks it is still inside the root — which works for paths about to be
created as well as ones that already exist.

**Why sharing publishes rather than moves.** A common folder anyone can write
into produces files that belong to nobody: they are in no one's quota, no one's
backup expectations, and no one's "my files". Publishing by reference keeps
every byte attributable to exactly one person. It costs a registry — one small
JSON file, kept in step by the same operations that move and delete files, plus
a daily sweep for anything changed behind the app's back.

**Why passkeys are enrolled, never bootstrapped.** Registration requires a
session that already exists, so a passkey can only ever be a second key to a
door somebody has already opened. Sign-in still re-checks the app permission
against LDAP, because holding a key proves identity, not entitlement.

**Why the service does not run as root.** It only reads and writes user files.
The systemd unit drops every capability, mounts the system read-only apart from
the data directory, and hides `/home`.
