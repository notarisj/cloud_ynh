## Storage

User files live in `/home/yunohost.app/cloud`, outside the install directory, so
upgrades never touch them. Removing the app leaves them in place; only
`yunohost app remove --purge` deletes them.

```
users/<username>/     private, one per account
shared/               visible to everyone with the app permission
.meta/trash/          deleted items, kept 30 days, then swept automatically
.meta/thumbs/         generated thumbnails, evicted least-recently-used at 512 MB
.meta/uploads/        chunks of uploads in flight, swept after 24 hours
.meta/tokens/         hashed refresh tokens, one file per account
```

Back up with `yunohost backup create --apps cloud`. The data directory is
included, so a full restore brings the files back with it.

## Quotas

Set at install time and changeable with `yunohost app setting`:

```bash
yunohost app setting cloud user_quota -v 50     # GB, 0 for unlimited
yunohost app setting cloud max_upload -v 20     # GB, per file
sudo yunohost app upgrade cloud                 # rewrites .env and restarts
```

Only the private area is metered. The shared area is not counted against anyone.

## Access

Access is the app's YunoHost permission:

```bash
yunohost user permission update cloud.main --add alice
yunohost user permission update cloud.main --remove bob
```

Removing someone signs their devices out the next time a token refreshes,
within fifteen minutes. Their files stay on disk.

The `cloud.api` permission is set to `visitors` and marked protected. That is
deliberate and must not be changed: it makes `/api/v1` reachable without a
portal cookie so the iOS app can authenticate, and every route behind it
requires a valid token. Restricting it would break native clients without
making anything safer.

## Thumbnails

Images use `libvips` (bundled with the app), videos use `ffmpeg`, PDFs use
`pdftoppm`. Both external tools are installed as dependencies; if either is
missing the corresponding files simply have no thumbnail and everything else
works. The startup log records what was found.

Turn previews off entirely:

```bash
yunohost app setting cloud enable_thumbnails -v false
sudo yunohost app upgrade cloud
```

## Logs

```bash
sudo journalctl -u cloud -f
sudo yunohost app log cloud
```

Authentication failures, rejected proxy secrets and SSOwat misconfiguration all
log a line explaining what to check.
