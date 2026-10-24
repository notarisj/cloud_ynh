#!/bin/bash
#
# __APP__-rescue — recover access to this Cloud instance from a shell.
#
# A user who turns off portal sign-in for their account can only get in with a
# passkey. If that passkey is lost — a wiped phone, a password manager they
# cannot open, a browser profile that is gone — the only way back is here, on
# the server, as root. That is the point: the recovery path is deliberately
# not reachable from the network.
#
# Everything below edits __DATA_DIR__/.meta/passkeys/<user>.json, which the
# service re-reads on every request, so no restart is needed.

set -euo pipefail

readonly APP="__APP__"
readonly DATA_DIR="__DATA_DIR__"
readonly STORE_DIR="$DATA_DIR/.meta/passkeys"

usage() {
    cat <<USAGE
$APP-rescue — recover access to $APP

  $APP-rescue status
        Show every account, its passkeys, and whether portal sign-in is off.

  $APP-rescue allow-portal <username>
        Turn portal (SSO) sign-in back on for an account. This is the command
        to run when someone has locked themselves out with a lost passkey.

  $APP-rescue deny-portal <username>
        Turn portal sign-in off again. Refused unless the account has at least
        one passkey, so this cannot be used to lock someone out entirely.

  $APP-rescue list <username>
        Show the passkeys registered to an account.

  $APP-rescue reset <username>
        Remove every passkey from an account and turn portal sign-in back on.
        The full reset, for when you are not sure what state things are in.

Run as root. Files are rewritten in place, keeping their owner and mode.
USAGE
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo "$APP-rescue: must be run as root (try: sudo $APP-rescue $*)" >&2
        exit 1
    fi
}

# All edits go through python3: it is present on every YunoHost system, and
# unlike a jq-and-mv pipeline it can rewrite the file without changing who owns
# it — a root-owned store would leave the service unable to write its own
# passkeys, which turns a rescue into a second outage.
edit_store() {
    local username="$1" action="$2"
    python3 - "$STORE_DIR" "$username" "$action" <<'PYTHON'
import json, os, sys, tempfile

store_dir, username, action = sys.argv[1], sys.argv[2], sys.argv[3]
path = os.path.join(store_dir, f"{username}.json")

if not os.path.exists(path):
    print(f"No passkey record for '{username}'.")
    if action == "allow-portal":
        print("Nothing to do: portal sign-in is only ever off for accounts that have one.")
        sys.exit(0)
    sys.exit(1)

with open(path, encoding="utf-8") as fh:
    data = json.load(fh)

if action == "allow-portal":
    data["ssoDisabled"] = False
elif action == "deny-portal":
    if not data.get("credentials"):
        sys.exit(f"'{username}' has no passkey — turning portal sign-in off would lock the account out.")
    data["ssoDisabled"] = True
elif action == "reset":
    data["credentials"] = []
    data["ssoDisabled"] = False

# Preserve owner and mode: the service writes this file as its own user.
stat = os.stat(path)
directory = os.path.dirname(path)
handle, temp = tempfile.mkstemp(dir=directory)
try:
    with os.fdopen(handle, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.chown(temp, stat.st_uid, stat.st_gid)
    os.chmod(temp, stat.st_mode & 0o777)
    os.replace(temp, path)
except BaseException:
    os.unlink(temp)
    raise

if action == "allow-portal":
    print(f"Portal sign-in re-enabled for '{username}'. They can sign in through the YunoHost portal again.")
elif action == "deny-portal":
    print(f"Portal sign-in disabled for '{username}'. Only their passkeys will work now.")
elif action == "reset":
    print(f"Removed every passkey from '{username}' and re-enabled portal sign-in.")
PYTHON
}

show_status() {
    python3 - "$STORE_DIR" <<'PYTHON'
import json, os, sys, datetime

store_dir = sys.argv[1]
if not os.path.isdir(store_dir):
    sys.exit("No passkey store yet — nobody has registered one.")

rows = []
for name in sorted(os.listdir(store_dir)):
    if not name.endswith(".json"):
        continue
    try:
        with open(os.path.join(store_dir, name), encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as err:
        rows.append((name[:-5], "?", f"unreadable ({err})"))
        continue
    count = len(data.get("credentials", []))
    state = "PASSKEY ONLY" if data.get("ssoDisabled") else "portal + passkey"
    rows.append((data.get("username", name[:-5]), str(count), state))

if not rows:
    sys.exit("No passkey store yet — nobody has registered one.")

width = max(len(r[0]) for r in rows + [("account", "", "")])
print(f"{'ACCOUNT'.ljust(width)}  PASSKEYS  SIGN-IN")
for username, count, state in rows:
    print(f"{username.ljust(width)}  {count.center(8)}  {state}")
PYTHON
}

list_passkeys() {
    python3 - "$STORE_DIR" "$1" <<'PYTHON'
import json, os, sys, datetime

store_dir, username = sys.argv[1], sys.argv[2]
path = os.path.join(store_dir, f"{username}.json")
if not os.path.exists(path):
    sys.exit(f"No passkey record for '{username}'.")

with open(path, encoding="utf-8") as fh:
    data = json.load(fh)

when = lambda ms: datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M") if ms else "never"
print(f"account       : {data.get('username', username)}")
print(f"portal sign-in: {'DISABLED — passkey only' if data.get('ssoDisabled') else 'enabled'}")
print(f"passkeys      : {len(data.get('credentials', []))}")
for credential in data.get("credentials", []):
    print(f"  - {credential.get('name', 'Passkey')}"
          f"  added {when(credential.get('createdAt'))}"
          f"  last used {when(credential.get('lastUsedAt'))}")
PYTHON
}

case "${1:-}" in
    status)
        require_root
        show_status
        ;;
    allow-portal | deny-portal | reset)
        require_root
        [ $# -eq 2 ] || { echo "usage: $APP-rescue $1 <username>" >&2; exit 1; }
        edit_store "$2" "$1"
        ;;
    list | passkeys)
        require_root
        [ $# -eq 2 ] || { echo "usage: $APP-rescue list <username>" >&2; exit 1; }
        list_passkeys "$2"
        ;;
    -h | --help | help | "")
        usage
        ;;
    *)
        echo "$APP-rescue: unknown command '$1'" >&2
        echo >&2
        usage >&2
        exit 1
        ;;
esac
