import { useCallback, useEffect, useState } from 'react';
import { Scrim } from './Dialogs';
import { Icon } from './Icon';
import * as api from '../lib/api';
import type { FileEntry } from '../lib/api';

interface FolderPickerProps {
  title: string;
  confirmLabel: string;
  /** Folders that cannot be chosen — you cannot move a folder into itself. */
  excluded: string[];
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

/**
 * Choose a destination folder.
 *
 * Cut-and-paste works, but it asks people to remember an invisible clipboard
 * across a navigation. Picking the destination in a small browser of its own
 * keeps the whole operation in view, and it is the only workable way to move
 * something on a touch screen.
 *
 * Only "My Files" is offered: Shared is a view of published items, not a place
 * anything can be put.
 */
export function FolderPicker({ title, confirmLabel, excluded, onConfirm, onCancel }: FolderPickerProps) {
  const [path, setPath] = useState('/me');
  const [folders, setFolders] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('Untitled Folder');

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const listing = await api.list(target, 'name', false);
        setFolders(listing.entries.filter((entry) => entry.isDir));
        setPath(listing.entry.path);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not open that folder.');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load('/me');
  }, [load]);

  const segments = path.split('/').filter(Boolean);
  const blocked = new Set(excluded);

  return (
    <Scrim onDismiss={onCancel}>
      <div className="dialog dialog--picker" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>

        <nav className="picker__crumbs" aria-label="Destination">
          {segments.map((segment, index) => {
            const target = '/' + segments.slice(0, index + 1).join('/');
            return (
              <span key={target} style={{ display: 'contents' }}>
                {index > 0 && <Icon name="chevronRight" size={12} weight={2.2} />}
                <button type="button" onClick={() => void load(target)}>
                  {index === 0 ? 'My Files' : segment}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="picker__list">
          {loading ? (
            <div className="centred" style={{ height: 120 }}><div className="spinner" /></div>
          ) : error ? (
            <p className="picker__empty">{error}</p>
          ) : folders.length === 0 ? (
            <p className="picker__empty">No folders here. The items will be placed in this folder.</p>
          ) : (
            folders.map((folder) => {
              const disabled = blocked.has(folder.path);
              return (
                <button
                  key={folder.path}
                  type="button"
                  className="picker__row"
                  disabled={disabled}
                  title={disabled ? 'Cannot place an item inside itself' : folder.name}
                  onClick={() => void load(folder.path)}
                >
                  <Icon name="folder" size={18} style={{ color: 'var(--accent)' }} />
                  <span>{folder.name}</span>
                  <Icon name="chevronRight" size={14} weight={2} style={{ color: 'var(--text-tertiary)' }} />
                </button>
              );
            })
          )}
        </div>

        {creating ? (
          <form
            className="picker__create"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newName.trim();
              if (name.length === 0) return;
              void api
                .createFolder(`${path}/${name}`)
                .then((entry) => {
                  setCreating(false);
                  setNewName('Untitled Folder');
                  return load(entry.path);
                })
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : 'Could not create that folder.'),
                );
            }}
          >
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              type="text"
              value={newName}
              autoFocus
              onChange={(event) => setNewName(event.target.value)}
              aria-label="New folder name"
            />
            <button type="submit" className="button">Create</button>
            <button type="button" className="button" onClick={() => setCreating(false)}>Cancel</button>
          </form>
        ) : (
          <button type="button" className="picker__new" onClick={() => setCreating(true)}>
            <Icon name="folderPlus" size={16} />
            New Folder
          </button>
        )}

        <div className="dialog__actions">
          <button type="button" className="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="button button--primary"
            disabled={blocked.has(path)}
            onClick={() => onConfirm(path)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Scrim>
  );
}
