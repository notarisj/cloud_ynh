## Storage

User files live in `/home/yunohost.app/cloud`, outside the install directory, so
upgrades never touch them. Removing the app leaves them in place; only
`yunohost app remove --purge` deletes them.

```
users/<username>/     every file, one root per account — including shared ones
.meta/shares.json     which items are published under /shared, and by whom
.meta/links.json      public links: which items anyone with the URL may download
.meta/trash/          deleted items, kept 30 days, then swept automatically
.meta/thumbs/         generated thumbnails, evicted least-recently-used at 512 MB
.meta/uploads/        chunks of uploads in flight, swept after 24 hours
.meta/tokens/         hashed refresh tokens, one file per account
.meta/passkeys/       registered passkeys (public keys only), one file per account
```

There is no common directory. "Shared" is a view built from `shares.json`: each
entry points at a path inside its owner's own root, so a shared file is never a
second copy and never becomes an orphan when the person who uploaded it leaves.
Deleting or moving the file updates the registry with it, and a daily sweep
drops any entry whose file has disappeared behind the app's back.

Back up with `yunohost backup create --apps cloud`. The data directory is
included, so a full restore brings the files and the shares back with it.

### Upgrading from 1.0

1.0 had a physical `shared/` folder anyone could upload into, which meant a file
could exist that belonged to nobody. The upgrade moves that folder aside to
`legacy-shared-<timestamp>/` and prints where it went; nothing is deleted. Move
anything worth keeping into a user's directory under `users/`, and that person
can share it again from the app.

## Configuration

`yunohost app config set cloud` (or the Config panel in the web admin) covers
the quota, the per-file upload ceiling, sharing, passkeys and thumbnails. The
panel re-renders the app's `.env` and restarts the service, so a change takes
effect immediately.

The equivalent from the command line:

```bash
yunohost app config set cloud main.storage.user_quota -v 50   # GB, 0 = unlimited
yunohost app config set cloud main.features.enable_shared -v false
```

Quotas count everything an account owns: its files, the items it has shared, and
whatever is still in its Recently Deleted. Nothing on the server is unmetered.

## Access

Access is the app's YunoHost permission:

```bash
yunohost user permission update cloud.main --add alice
yunohost user permission update cloud.main --remove bob
```

Removing someone signs their devices out the next time a token refreshes, within
fifteen minutes, and their passkeys stop working at the same point — possession
of a key proves who you are, not that you are still allowed in. Their files stay
on disk, and anything they had shared disappears from everyone else's Shared
view along with their access.

The `cloud.api` permission is set to `visitors` and marked protected. That is
deliberate and must not be changed: it makes `/api/v1` reachable without a
portal cookie so the iOS app and passkey sign-in can work, and every route
behind it requires a valid token. Restricting it would break native clients
without making anything safer.

## Public links

Users can publish a file or folder to anyone who has its link — someone with
no account on the server. Links live at `/cloud/s/<token>` through the
`cloud.links` permission, which is open to visitors for exactly that reason;
like `cloud.api`, it must stay that way. Each link can expire, and its owner
can remove it at any time from the item or from Settings.

```bash
yunohost app config set cloud main.features.enable_public_links -v false
```

Turning the feature off stops every link working at once without deleting
any; they work again if it is turned back on. Removing an item, or its
owner's account files, removes its links with it.

## Passkeys

A passkey is registered from an already-authenticated session — a user signs in
through the portal once, opens Settings and adds one. The server stores only a
public key and a counter; there is nothing in `.meta/passkeys/` that could be
replayed against another site, or against this one.

Credentials are bound to the app's domain. Changing the domain with
`yunohost app change-url` therefore invalidates every enrolled passkey, and the
change_url script says so — users sign in through the portal and enrol again.

To turn the feature off entirely:

```bash
yunohost app config set cloud main.features.enable_passkeys -v false
```

Existing credentials are not deleted; they simply stop being offered, and start
working again if the switch is turned back on.

A user with a passkey can also choose **Passkeys only** in Settings, which stops
the portal from signing them in to this app in a browser. They can turn it back
on from the same place, and removing their last passkey turns it back on by
itself, so nobody can lock themselves out this way. The iOS app keeps signing
in with the account password either way.

## Thumbnails

Images use `libvips` (bundled with the app), iPhone HEIC photos use libheif's
`heif-convert`, videos use `ffmpeg`, PDFs use `pdftoppm`. The external tools are
installed as dependencies; if one is
missing the corresponding files simply have no thumbnail and everything else
works. The startup log records what was found.

## Logs

```bash
sudo journalctl -u cloud -f
sudo yunohost app log cloud
```

Authentication failures, rejected proxy secrets, SSOwat misconfiguration, a
share registry that had to be pruned, and a leftover legacy folder all log a
line explaining what to check.
