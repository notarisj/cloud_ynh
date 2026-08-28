import { useState, useEffect } from 'react';
import { Scrim } from './Dialogs';
import * as api from '../lib/api';
import type { User, FileEntry } from '../lib/api';

interface ShareDialogProps {
  entries: FileEntry[];
  onCancel: () => void;
  onConfirm: (visibility: 'all' | 'users', sharedWith: string[]) => void;
}

export function ShareDialog({ entries, onCancel, onConfirm }: ShareDialogProps) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [visibility, setVisibility] = useState<'all' | 'users'>('all');
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getUsers()
      .then(res => setUsers(res.users))
      .catch(err => setError(err.message));
  }, []);

  const title = entries.length === 1 ? `Share “${entries[0]?.name}”` : `Share ${entries.length} items`;

  const toggleUser = (username: string) => {
    setSharedWith(prev => 
      prev.includes(username) ? prev.filter(u => u !== username) : [...prev, username]
    );
  };

  return (
    <Scrim onDismiss={onCancel}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="share-title">
        <header className="dialog__head">
          <h2 id="share-title">{title}</h2>
        </header>

        <div className="dialog__body" style={{ minWidth: 320 }}>
          {error ? (
            <p style={{ color: 'var(--red)' }}>{error}</p>
          ) : users === null ? (
            <div className="spinner" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === 'all'}
                  onChange={() => setVisibility('all')}
                />
                Everyone on this server
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === 'users'}
                  onChange={() => setVisibility('users')}
                />
                Specific users
              </label>

              {visibility === 'users' && (
                <div style={{ padding: '8px', border: '1px solid var(--separator)', borderRadius: '4px', maxHeight: '200px', overflowY: 'auto' }}>
                  {users.length === 0 ? (
                    <p className="sheet__empty">No other users exist.</p>
                  ) : (
                    users.map(u => (
                      <label key={u.username} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }}>
                        <input
                          type="checkbox"
                          checked={sharedWith.includes(u.username)}
                          onChange={() => toggleUser(u.username)}
                        />
                        {u.displayName || u.username}
                      </label>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="dialog__actions">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={users === null || (visibility === 'users' && sharedWith.length === 0)}
            onClick={() => onConfirm(visibility, sharedWith)}
          >
            Share
          </button>
        </div>
      </div>
    </Scrim>
  );
}
