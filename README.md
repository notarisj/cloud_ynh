# Cloud — YunoHost app

Personal file storage with a web interface and a native iOS client. Upload,
browse, preview and download your files; each account gets a private area and
everyone with access shares a common one.

Packaged for YunoHost 12, following the same conventions as `wg-man_ynh`.

## What you get

- **Per-user private storage** at `/me`, plus an optional shared area at `/shared`.
- **A web interface** — file browser with list and icon views, thumbnails for
  images, videos and PDFs, drag-and-drop upload, search, and Recently Deleted.
- **Resumable uploads.** Large files are sent in 8 MB chunks straight to their
  final offset on disk, so an interrupted upload resumes instead of restarting.
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
| Shared folder | yes | A `/shared` area everyone with access can use |
| Thumbnails | yes | Needs `ffmpeg` and `poppler-utils`, installed automatically |

## Where things live

```
/var/www/cloud/              the built app (owned by the cloud system user)
/home/yunohost.app/cloud/
├── users/<username>/        one private root per account
├── shared/                  the common area
└── .meta/
    ├── trash/<username>/    deleted items, kept 30 days
    ├── thumbs/              generated thumbnails, capped at 512 MB
    ├── uploads/             chunks of uploads still in flight
    └── tokens/              hashed refresh tokens, one file per account
```

Only `install_dir` is replaced on upgrade. `data_dir` holds the users' files and
is left alone — and it is removed only when you purge the app.

## How authentication works

Two ways in, one authorisation path.

**The browser** already has a YunoHost portal session. It calls
`/api/sso/session`, which sits behind SSOwat; nginx injects the user's identity
and the API exchanges it for a 15-minute access token. The token is held in
memory and re-minted after a reload, so there is no cookie to steal and no CSRF
surface.

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
| `DELETE` | `/files/?path=&permanent=` | To Recently Deleted, or for good |

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

Paths are virtual: `/me/Documents/report.pdf`, `/shared/Team/logo.png`. The
first segment names a root, so a device that signs in as somebody else sees the
right files without rewriting anything it cached.

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

**Why the service does not run as root.** It only reads and writes user files.
The systemd unit drops every capability, mounts the system read-only apart from
the data directory, and hides `/home`.
