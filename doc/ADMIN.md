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
the quota, the per-file upload ceiling, extra administrators, sharing, public
links, passkeys and thumbnails. The
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

### Administrators

Members of the YunoHost `admins` group administer the app. To make someone else
an administrator of Cloud alone, name them in the config panel's **Extra
administrators** field (comma-separated):

```bash
yunohost app config set cloud main.access.admin_users -v "alice,bob"
```

Administrators can stop any share and manage the accounts described next.

### Accounts that exist only in Cloud

An administrator can add an account from **Users** in the sidebar — for someone
who needs a folder here but not a YunoHost account. It signs in with a username
and password, from the browser or the iOS app, and gets its own My Files like
anyone else. Names already used by a YunoHost or system account are refused, and
if one is ever created later with the same name, the YunoHost account wins and
the local one stops signing in.

The accounts live in `.meta/users.json` with scrypt-hashed passwords. Removing
one signs it out everywhere and forgets its passkeys; its files stay in
`users/<name>` until you delete them.

### Turning accounts off, and other administration

Every account — YunoHost's as well as Cloud-only ones — can be turned off for
Cloud from **Users**: it is signed out everywhere at once and refused at every
way in (password, passkey, portal, the apps) until it is turned back on.
Nothing changes in YunoHost. The same screen makes an account a Cloud
administrator or not, signs it out of every device, and shows its storage and
when it was last active. Cloud-only accounts can also have their password
reset, and be removed. YunoHost passwords, and admin rank that comes from the
admins group or **Extra administrators**, stay with YunoHost.

These decisions live in `.meta/user-policy.json`.

### Quick sign-in from the iPhone

The sign-in page offers **Sign in with your iPhone**: it shows a QR code and a
number. In the iOS app, **Settings › Sign In a Browser** scans the code, shows
which browser is asking, and asks for that number and Face ID. The browser
then gets a session of its own, listed under Signed-In Devices.

A code lasts two minutes and works once. Collecting the session needs a secret
that only the browser that asked holds, so a photo of the code is useless; and
the number has to be read off the browser that asked, so a code someone sends
you cannot be used to sign *them* in to your account. Accounts that are turned
off cannot approve or be signed in. This also works for passkey-only accounts:
the portal is what they turned off, and this is not the portal.

### Who sees a share

A share reaches either everyone signed in to the app, or only the people its
owner picks. An item shared with named people does not appear in anyone else's
Shared view, search or sync, and its path answers as if it did not exist.

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
## Passkey-only accounts, and the way back in

A user who has registered a passkey can turn portal sign-in off for their own
account, in Settings. From then on the YunoHost portal will not open this app
for them: the passkey is the only way in. The app asks them to confirm with the
passkey before it does this, so a key that does not actually work cannot be
what they are left with, and it shows them the recovery command before the
switch as well as after.

Only the account itself is affected. Everyone else on the server signs in
through the portal exactly as before.

When someone does lose that passkey, the way back is on the server, as root:

```bash
sudo cloud-rescue allow-portal alice     # give one account the portal back
sudo cloud-rescue status                 # who is passkey-only, and how many keys they hold
sudo cloud-rescue list alice             # that account's passkeys, when each was last used
sudo cloud-rescue reset alice            # remove every passkey and re-enable the portal
```

Deliberately there is no network path to this. An account with no passkey
cannot be switched to passkey-only — `deny-portal` refuses — so the command
cannot be used to lock somebody out either.

The commands edit `.meta/passkeys/<user>.json` in place, keeping its owner and
mode, and the service re-reads that file on every request. No restart is
needed. On a second instance the command is named after it: `cloud__2-rescue`.

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
