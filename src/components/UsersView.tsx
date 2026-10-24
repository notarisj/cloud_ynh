import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Avatar } from './Avatar';
import { ConfirmDialog, Scrim } from './Dialogs';
import { Icon } from './Icon';
import * as api from '../lib/api';
import type { Session, User } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';

interface UsersViewProps {
  session: Session;
  onClose: () => void;
}

/**
 * People on this server, for administrators.
 *
 * Every account can be turned off for Cloud, made an administrator of Cloud or
 * not, and signed out everywhere — YunoHost's users as much as the ones made
 * here. What stays with YunoHost is what YunoHost owns: its users' passwords,
 * and admin rank given by its admins group. Accounts made here can also have
 * their password reset, and be removed.
 */
export function UsersView({ session, onClose }: UsersViewProps) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [minPassword, setMinPassword] = useState(8);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.getUsers();
      setUsers(result.users as User[]);
      if (result.minPasswordLength) setMinPassword(result.minPasswordLength);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load people.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Run one change; the server answers with the account as it now is. */
  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const chosen = users?.find((user) => user.username === open) ?? null;

  return (
    <Scrim onDismiss={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Users">
        <header className="sheet__head">
          {chosen || adding ? (
            <button
              type="button"
              className="sheet__back"
              onClick={() => {
                setOpen(null);
                setAdding(false);
                setError(null);
              }}
            >
              <Icon name="chevronLeft" size={17} weight={2} />
              Users
            </button>
          ) : (
            <h2>Users</h2>
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="iconbutton" onClick={onClose} aria-label="Close users">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="sheet__body">
          {error && (
            <div className="banner" role="alert">
              <Icon name="warning" size={16} />
              <span style={{ flex: 1 }}>{error}</span>
            </div>
          )}

          {adding ? (
            <NewAccount
              minPassword={minPassword}
              busy={busy}
              onCreate={(username, password, isAdmin) =>
                run(() => api.createUser(username, password, isAdmin)).then((done) => {
                  if (done) setAdding(false);
                })
              }
            />
          ) : chosen ? (
            <PersonDetail
              user={chosen}
              me={session.user.username}
              minPassword={minPassword}
              busy={busy}
              run={run}
              onRemoved={() => setOpen(null)}
            />
          ) : (
            <section className="sheet__section">
              <p className="sheet__lede">
                Everyone who can use Cloud. Turn an account off to keep it out of Cloud without
                touching it in YunoHost.
              </p>

              {users === null ? (
                <div className="spinner" />
              ) : (
                users.map((user) => (
                  <button
                    key={user.username}
                    type="button"
                    className="sheet__row sheet__row--link"
                    onClick={() => setOpen(user.username)}
                  >
                    <Avatar name={user.displayName || user.username} size={32} />
                    <div className="sheet__rowtext">
                      <strong>
                        {user.displayName || user.username}
                        {user.isAdmin && <span className="pill">Admin</span>}
                        {user.disabled && <span className="pill pill--muted">Off</span>}
                      </strong>
                      <span>
                        {user.username} · {user.source === 'local' ? 'Cloud account' : 'YunoHost user'}
                        {user.username === session.user.username && ' · you'}
                      </span>
                    </div>
                    <Icon name="chevronRight" size={14} weight={2} className="sheet__chevron" />
                  </button>
                ))
              )}

              <button type="button" className="button" onClick={() => setAdding(true)} disabled={busy}>
                Add Account…
              </button>
            </section>
          )}
        </div>
      </div>
    </Scrim>
  );
}

// MARK: - One person

function PersonDetail({
  user,
  me,
  minPassword,
  busy,
  run,
  onRemoved,
}: {
  user: User;
  me: string;
  minPassword: number;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
  onRemoved: () => void;
}) {
  const [resetting, setResetting] = useState(false);
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState<'remove' | 'signout' | null>(null);
  const self = user.username === me;
  const local = user.source === 'local';

  return (
    <>
      <section className="sheet__section person">
        <Avatar name={user.displayName || user.username} size={56} />
        <strong className="person__name">{user.displayName || user.username}</strong>
        <p className="person__meta">
          {user.username} · {local ? 'Cloud account' : 'YunoHost user'}
          {user.email ? ` · ${user.email}` : ''}
        </p>
      </section>

      <section className="sheet__section">
        <h3>Access</h3>
        <label className="sheet__row switchrow">
          <div className="sheet__rowtext">
            <strong>Allow Sign-In</strong>
            <span>
              {self
                ? 'You cannot turn off your own account.'
                : user.disabled
                  ? 'Turned off: this account cannot use Cloud, on any device.'
                  : 'This account can use Cloud.'}
            </span>
          </div>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={!user.disabled}
            disabled={busy || self}
            onChange={(event) => void run(() => api.updateUser(user.username, { disabled: !event.target.checked }))}
          />
        </label>
        <label className="sheet__row switchrow">
          <div className="sheet__rowtext">
            <strong>Administrator</strong>
            <span>
              {user.adminFromServer
                ? 'Given by YunoHost’s admins group or the app’s settings; change it there.'
                : self
                  ? 'You cannot remove your own administrator rights.'
                  : 'Can manage people and stop any share.'}
            </span>
          </div>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={user.isAdmin}
            disabled={busy || user.adminFromServer || (self && user.isAdmin)}
            onChange={(event) => void run(() => api.updateUser(user.username, { isAdmin: event.target.checked }))}
          />
        </label>
      </section>

      <section className="sheet__section">
        <h3>Activity</h3>
        <div className="sheet__row">
          <div className="sheet__rowtext">
            <strong>Storage</strong>
          </div>
          <span className="sheet__value">{formatBytes(user.usedBytes)}</span>
        </div>
        <div className="sheet__row">
          <div className="sheet__rowtext">
            <strong>Last Active</strong>
          </div>
          <span className="sheet__value">{user.lastActiveAt ? formatDate(user.lastActiveAt) : 'Never'}</span>
        </div>
        <div className="sheet__row">
          <div className="sheet__rowtext">
            <strong>Signed-In Devices</strong>
          </div>
          <span className="sheet__value">{user.devices}</span>
        </div>
        <button
          type="button"
          className="button"
          disabled={busy || user.devices === 0}
          onClick={() => setConfirming('signout')}
        >
          Sign Out Everywhere
        </button>
      </section>

      <section className="sheet__section">
        <h3>Password</h3>
        {!local ? (
          <p className="sheet__lede">YunoHost users change their password in YunoHost.</p>
        ) : resetting ? (
          <form
            className="form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void run(() => api.updateUser(user.username, { password })).then((done) => {
                if (done) {
                  setResetting(false);
                  setPassword('');
                }
              });
            }}
          >
            <label className="form__field">
              <span>New Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                minLength={minPassword}
                autoFocus
                required
              />
            </label>
            <p className="form__hint">
              At least {minPassword} characters. Every device signed in to this account signs in again.
            </p>
            <div className="dialog__actions">
              <button type="button" className="button" onClick={() => setResetting(false)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="button button--primary" disabled={busy || password.length < minPassword}>
                Set Password
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="button" onClick={() => setResetting(true)} disabled={busy}>
            Reset Password…
          </button>
        )}
      </section>

      {local && !self && (
        <section className="sheet__section">
          <button type="button" className="button button--danger" onClick={() => setConfirming('remove')} disabled={busy}>
            Remove Account…
          </button>
        </section>
      )}

      {confirming === 'remove' && (
        <ConfirmDialog
          title={`Remove “${user.username}”?`}
          message="They are signed out everywhere and can no longer sign in. Their files stay on the server, where an administrator can still reach them."
          confirmLabel="Remove"
          destructive
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void run(() => api.deleteUser(user.username)).then((done) => done && onRemoved());
          }}
        />
      )}

      {confirming === 'signout' && (
        <ConfirmDialog
          title={`Sign out “${user.username}” everywhere?`}
          message="Every device and browser signed in to this account will need to sign in again."
          confirmLabel="Sign Out"
          destructive
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void run(() => api.signOutUser(user.username));
          }}
        />
      )}
    </>
  );
}

// MARK: - A new Cloud account

function NewAccount({
  minPassword,
  busy,
  onCreate,
}: {
  minPassword: number;
  busy: boolean;
  onCreate: (username: string, password: string, isAdmin: boolean) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const valid = /^[a-z][a-z0-9._-]{0,31}$/.test(username.trim()) && password.length >= minPassword;

  return (
    <section className="sheet__section">
      <h3>New Account</h3>
      <p className="sheet__lede">
        An account that exists only in Cloud, for someone who needs a folder here but not a
        YunoHost account. It signs in with the password you give it, on the web or in the app.
      </p>
      <form
        className="form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (valid) onCreate(username.trim(), password, isAdmin);
        }}
      >
        <label className="form__field">
          <span>Username</span>
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value.toLowerCase())}
            autoFocus
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        <label className="form__field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={minPassword}
            required
          />
        </label>
        <p className="form__hint">
          Lowercase letters, digits, dots and dashes, starting with a letter. At least {minPassword}{' '}
          characters of password.
        </p>
        <label className="sheet__row switchrow">
          <div className="sheet__rowtext">
            <strong>Administrator</strong>
            <span>Can manage people and stop any share.</span>
          </div>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={isAdmin}
            onChange={(event) => setIsAdmin(event.target.checked)}
          />
        </label>
        <div className="dialog__actions">
          <button type="submit" className="button button--primary" disabled={busy || !valid}>
            {busy ? <span className="spinner spinner--light" /> : 'Add Account'}
          </button>
        </div>
      </form>
    </section>
  );
}
