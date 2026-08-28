import { useCallback, useEffect, useState } from 'react';
import { Scrim } from './Dialogs';
import { Icon } from './Icon';
import * as api from '../lib/api';
import type { User, Session } from '../lib/api';

interface UsersViewProps {
  session: Session;
  onClose: () => void;
}

export function UsersView({ session, onClose }: UsersViewProps) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getUsers();
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const handleAddUser = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.createUser(newUsername, newPassword, newIsAdmin);
      setIsAdding(false);
      setNewUsername('');
      setNewPassword('');
      setNewIsAdmin(false);
    });
  };

  const handleDeleteUser = (username: string) => {
    if (!confirm(`Are you sure you want to delete ${username}?`)) return;
    void run(() => api.deleteUser(username));
  };

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

          {isAdding ? (
            <section className="sheet__section">
              <h3>Add Local User</h3>
              <form onSubmit={handleAddUser} style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
                <input
                  className="input"
                  value={newUsername}
                  onChange={e => setNewUsername(e.target.value)}
                  placeholder="Username"
                  required
                  autoFocus
                />
                <input
                  className="input"
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="Password"
                  required
                  minLength={4}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
                  <input
                    type="checkbox"
                    checked={newIsAdmin}
                    onChange={e => setNewIsAdmin(e.target.checked)}
                  />
                  Administrator
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button type="submit" className="button button--primary" disabled={busy}>Save</button>
                  <button type="button" className="button" onClick={() => setIsAdding(false)} disabled={busy}>Cancel</button>
                </div>
              </form>
            </section>
          ) : (
            <section className="sheet__section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3>All Users</h3>
                {session.user.isAdmin && (
                  <button type="button" className="button button--primary" onClick={() => setIsAdding(true)} disabled={busy}>
                    Add User
                  </button>
                )}
              </div>
              
              {users === null ? (
                <div className="spinner" />
              ) : users.length === 0 ? (
                <p className="sheet__empty">No users found.</p>
              ) : (
                users.map((u) => (
                  <div key={u.username} className="sheet__row" style={{ marginTop: '12px' }}>
                    <div className="storage__avatar" aria-hidden="true">
                      {u.displayName.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="sheet__rowtext">
                      <strong>{u.displayName} {u.isAdmin && <span className="pill">Admin</span>}</strong>
                      <span>
                        {u.source === 'ldap' ? 'YunoHost User' : 'Local User'}
                        {u.username === session.user.username && ' (You)'}
                      </span>
                    </div>
                    {session.user.isAdmin && u.source === 'local' && u.username !== session.user.username && (
                      <button
                        type="button"
                        className="iconbutton"
                        aria-label={`Remove ${u.username}`}
                        title="Remove User"
                        onClick={() => handleDeleteUser(u.username)}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                  </div>
                ))
              )}
            </section>
          )}
        </div>
      </div>
    </Scrim>
  );
}
