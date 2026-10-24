import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Avatar } from './Avatar';
import { ConfirmDialog, Scrim } from './Dialogs';
import { Icon } from './Icon';
import * as api from '../lib/api';
import type { Session, User } from '../lib/api';

interface UsersViewProps {
  session: Session;
  onClose: () => void;
}

/**
 * People on this server, for administrators.
 *
 * YunoHost users are listed but managed in YunoHost. What can be done here is
 * the one thing YunoHost cannot: give someone an account in Cloud alone — a
 * relative who needs a folder, not a mailbox.
 */
export function UsersView({ session, onClose }: UsersViewProps) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [minPassword, setMinPassword] = useState(8);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<User | null>(null);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

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

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const done = await run(() => api.createUser(username.trim(), password, isAdmin));
    if (done) {
      setAdding(false);
      setUsername('');
      setPassword('');
      setIsAdmin(false);
    }
  };

  const valid = /^[a-z][a-z0-9._-]{0,31}$/.test(username.trim()) && password.length >= minPassword;

  return (
    <Scrim onDismiss={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Users">
        <header className="sheet__head">
          <h2>Users</h2>
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

          <section className="sheet__section">
            <h3>People</h3>
            <p className="sheet__lede">
              Everyone who can sign in to Cloud. YunoHost users are managed in YunoHost; accounts
              added here exist only in Cloud and sign in with the password you give them.
            </p>

            {users === null ? (
              <div className="spinner" />
            ) : users.length === 0 ? (
              <p className="sheet__empty">Nobody yet.</p>
            ) : (
              users.map((user) => (
                <div key={user.username} className="sheet__row">
                  <Avatar name={user.displayName || user.username} size={32} />
                  <div className="sheet__rowtext">
                    <strong>
                      {user.displayName || user.username}
                      {user.isAdmin && <span className="pill">Admin</span>}
                    </strong>
                    <span>
                      {user.username}
                      {' · '}
                      {user.source === 'local' ? 'Cloud account' : 'YunoHost user'}
                      {user.username === session.user.username && ' · you'}
                    </span>
                  </div>
                  {user.source === 'local' && user.username !== session.user.username && (
                    <button
                      type="button"
                      className="iconbutton"
                      aria-label={`Remove ${user.username}`}
                      title="Remove"
                      onClick={() => setRemoving(user)}
                      disabled={busy}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  )}
                </div>
              ))
            )}

            {!adding && (
              <button type="button" className="button" onClick={() => setAdding(true)} disabled={busy}>
                Add Account…
              </button>
            )}
          </section>

          {adding && (
            <section className="sheet__section">
              <h3>New Account</h3>
              <form className="form" onSubmit={(event) => void add(event)}>
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
                  Lowercase letters, digits, dots and dashes, starting with a letter. At least{' '}
                  {minPassword} characters of password.
                </p>
                <label className="form__check">
                  <input type="checkbox" checked={isAdmin} onChange={(event) => setIsAdmin(event.target.checked)} />
                  <span>Administrator — can add and remove accounts, and stop any share</span>
                </label>
                <div className="dialog__actions">
                  <button type="button" className="button" onClick={() => setAdding(false)} disabled={busy}>
                    Cancel
                  </button>
                  <button type="submit" className="button button--primary" disabled={busy || !valid}>
                    {busy ? <span className="spinner spinner--light" /> : 'Add Account'}
                  </button>
                </div>
              </form>
            </section>
          )}
        </div>
      </div>

      {removing && (
        <ConfirmDialog
          title={`Remove “${removing.username}”?`}
          message="They are signed out everywhere and can no longer sign in. Their files stay on the server, where an administrator can still reach them."
          confirmLabel="Remove"
          destructive
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void run(() => api.deleteUser(target.username));
          }}
        />
      )}
    </Scrim>
  );
}
