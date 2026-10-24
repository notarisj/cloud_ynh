import { useEffect, useMemo, useState } from 'react';
import { Avatar } from './Avatar';
import { Scrim } from './Dialogs';
import { Icon } from './Icon';
import * as api from '../lib/api';
import type { FileEntry, Person } from '../lib/api';

export type Visibility = 'all' | 'users';

interface ShareDialogProps {
  entries: FileEntry[];
  /** The account doing the sharing, left out of the list of people. */
  me: string;
  onCancel: () => void;
  onConfirm: (visibility: Visibility, sharedWith: string[]) => void;
}

/**
 * Who a share reaches: everyone signed in to this server, or only the people
 * picked here. Opened again on an item that is already shared, it starts from
 * the current choice, so the same sheet is how sharing is changed.
 */
export function ShareDialog({ entries, me, onCancel, onConfirm }: ShareDialogProps) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('all');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Whether this changes an existing share rather than making a new one.
  const [existing, setExisting] = useState(false);

  const only = entries.length === 1 ? entries[0] : undefined;

  useEffect(() => {
    let cancelled = false;
    api
      .getUsers()
      .then(({ users }) => !cancelled && setPeople(users.filter((person) => person.username !== me)))
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : 'Could not load people.'));

    if (only?.shared) {
      void api
        .listShares()
        .then(({ shares }) => {
          const current = shares.find((share) => share.path === only.path);
          if (cancelled || !current) return;
          setExisting(true);
          setVisibility(current.visibility ?? 'all');
          setChosen(new Set(current.sharedWith ?? []));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [me, only]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!people || needle === '') return people ?? [];
    return people.filter(
      (person) =>
        person.displayName.toLowerCase().includes(needle) || person.username.toLowerCase().includes(needle),
    );
  }, [people, filter]);

  const toggle = (username: string) =>
    setChosen((previous) => {
      const next = new Set(previous);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });

  const title = only ? `Share “${only.name}”` : `Share ${entries.length} Items`;
  const ready = visibility === 'all' || chosen.size > 0;

  return (
    <Scrim onDismiss={onCancel}>
      <form
        className="dialog dialog--share"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onConfirm(visibility, visibility === 'users' ? [...chosen] : []);
        }}
      >
        <h2>{title}</h2>
        <p>
          {visibility === 'all'
            ? 'Everyone who signs in to this server will find it in Shared.'
            : 'Only the people you choose will find it in Shared.'}{' '}
          It stays in your files and counts against your storage.
        </p>

        <div className="segmented" role="radiogroup" aria-label="Who can see it">
          <button type="button" role="radio" aria-checked={visibility === 'all'} onClick={() => setVisibility('all')}>
            Everyone
          </button>
          <button type="button" role="radio" aria-checked={visibility === 'users'} onClick={() => setVisibility('users')}>
            Only People I Choose
          </button>
        </div>

        {error && (
          <div className="banner" role="alert">
            <Icon name="warning" size={16} />
            <span style={{ flex: 1 }}>{error}</span>
          </div>
        )}

        {visibility === 'users' && (
          <>
            <input
              type="text"
              className="share__filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search people"
              aria-label="Search people"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="picker__list share__people" role="group" aria-label="People">
              {people === null ? (
                <div className="centred" style={{ height: '100%' }}><div className="spinner" /></div>
              ) : shown.length === 0 ? (
                <p className="picker__empty">
                  {people.length === 0 ? 'Nobody else has an account on this server yet.' : 'No matches.'}
                </p>
              ) : (
                shown.map((person) => {
                  const picked = chosen.has(person.username);
                  return (
                    <button
                      key={person.username}
                      type="button"
                      className="picker__row"
                      role="checkbox"
                      aria-checked={picked}
                      onClick={() => toggle(person.username)}
                    >
                      <Avatar name={person.displayName || person.username} size={26} />
                      <span>
                        {person.displayName || person.username}
                        {person.displayName && person.displayName !== person.username && (
                          <small className="share__handle">{person.username}</small>
                        )}
                      </span>
                      {picked && <Icon name="check" size={16} weight={2.2} style={{ color: 'var(--accent)' }} />}
                    </button>
                  );
                })
              )}
            </div>
            <p className="share__count">
              {chosen.size === 0 ? 'Choose at least one person.' : `${chosen.size} ${chosen.size === 1 ? 'person' : 'people'} chosen`}
            </p>
          </>
        )}

        <div className="dialog__actions">
          <button type="button" className="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="button button--primary" disabled={!ready}>
            {existing ? 'Save' : 'Share'}
          </button>
        </div>
      </form>
    </Scrim>
  );
}
