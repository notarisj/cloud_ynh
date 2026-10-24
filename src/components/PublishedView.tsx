import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import * as api from '../lib/api';
import type { LinkSummary, ShareSummary } from '../lib/api';
import { formatDate, shareAudience } from '../lib/format';

/** "/me/Photos/Trip" as "My Files › Photos › Trip". */
function displayPath(vpath: string): string {
  const [, ...rest] = vpath.split('/').filter(Boolean);
  return ['My Files', ...rest].join(' › ');
}

function parentOf(vpath: string): string {
  return vpath.split('/').slice(0, -1).join('/') || '/me';
}

interface PublishedViewProps {
  kind: 'shares' | 'links';
  /** Open the folder an item lives in. */
  onReveal: (folder: string) => void;
  onError: (message: string) => void;
}

/**
 * What you have published: items shared on the server, or public links.
 *
 * Places rather than settings: both lists grow with use — a hundred shares is
 * a hundred rows — so each has the main area to itself, laid out like every
 * other list in the app, instead of making the Settings panel longer each time.
 */
export function PublishedView({ kind, onReveal, onError }: PublishedViewProps) {
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [links, setLinks] = useState<LinkSummary[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (kind === 'shares') setShares((await api.listShares()).shares);
      else setLinks((await api.listLinks()).links);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not load this list.');
    }
  }, [kind, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = (work: () => Promise<unknown>) =>
    void work()
      .then(load)
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : 'That did not work.'));

  const items = kind === 'shares' ? shares : links;
  if (items === null) return <div className="centred"><div className="spinner" /></div>;

  if (items.length === 0) {
    return (
      <div className="empty">
        <Icon name={kind === 'shares' ? 'shared' : 'link'} size={48} weight={1.2} />
        <h2>{kind === 'shares' ? 'Nothing shared' : 'No public links'}</h2>
        <p>
          {kind === 'shares'
            ? 'Share a file or folder from its menu and it appears here, with who it reaches.'
            : 'Make a link from an item’s menu to let anyone download it — no account needed.'}
        </p>
      </div>
    );
  }

  return (
    <div className="list">
      <div className="list__header" role="presentation">
        <span className="list__check" />
        <span>Name</span>
        <span>{kind === 'shares' ? 'Reaches' : 'Expires'}</span>
        <span>Location</span>
        <span />
      </div>

      {kind === 'shares'
        ? shares!.map((item) => (
            <div key={item.id} className="row" style={{ cursor: 'default' }}>
              <span className="list__check" />
              <span className="row__name">
                <span className="row__icon">
                  <Icon name={item.isDir === false ? 'file' : 'folder'} size={19} weight={1.4} style={{ color: 'var(--accent)' }} />
                </span>
                <span>{item.name}</span>
              </span>
              <span className="row__meta">{shareAudience(item)}</span>
              <span className="row__meta">{displayPath(parentOf(item.path))}</span>
              <span style={{ display: 'flex', gap: 2 }}>
                <button
                  type="button"
                  className="iconbutton"
                  title="Show in folder"
                  aria-label={`Show ${item.name} in its folder`}
                  onClick={() => onReveal(parentOf(item.path))}
                >
                  <Icon name="folder" size={16} />
                </button>
                <button
                  type="button"
                  className="iconbutton"
                  title="Stop sharing"
                  aria-label={`Stop sharing ${item.name}`}
                  onClick={() => act(() => api.unshareById(item.id))}
                >
                  <Icon name="close" size={16} />
                </button>
              </span>
            </div>
          ))
        : links!.map((link) => (
            <div key={link.id} className="row" style={{ cursor: 'default' }}>
              <span className="list__check" />
              <span className="row__name">
                <span className="row__icon">
                  <Icon name="link" size={19} weight={1.4} style={{ color: 'var(--accent)' }} />
                </span>
                <span>{link.name}</span>
              </span>
              <span className="row__meta">{link.expiresAt ? formatDate(link.expiresAt) : 'Never'}</span>
              <span className="row__meta">{displayPath(parentOf(link.path))}</span>
              <span style={{ display: 'flex', gap: 2 }}>
                <button
                  type="button"
                  className="iconbutton"
                  title={copied === link.id ? 'Copied' : 'Copy link'}
                  aria-label={`Copy the link to ${link.name}`}
                  onClick={() =>
                    void navigator.clipboard?.writeText(link.url).then(() => {
                      setCopied(link.id);
                      window.setTimeout(() => setCopied(null), 1500);
                    })
                  }
                >
                  <Icon name={copied === link.id ? 'check' : 'copy'} size={16} />
                </button>
                <button
                  type="button"
                  className="iconbutton"
                  title="Remove link"
                  aria-label={`Remove the link to ${link.name}`}
                  onClick={() => act(() => api.removeLink(link.id))}
                >
                  <Icon name="trash" size={16} />
                </button>
              </span>
            </div>
          ))}
    </div>
  );
}
