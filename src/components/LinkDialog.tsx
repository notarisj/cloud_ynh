import { useEffect, useState } from 'react';
import { Scrim } from './Dialogs';
import { Icon } from './Icon';
import * as api from '../lib/api';
import type { FileEntry, LinkSummary } from '../lib/api';
import { formatExactDate } from '../lib/format';

/** How long a new link lasts. The same choices the iOS app offers. */
export const LINK_DURATIONS: { label: string; days: number | null }[] = [
  { label: '1 day', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: 'Never', days: null },
];

/**
 * Publishing one item to anyone with its URL — someone with no account here.
 * A share reaches everyone signed in to this server; a link reaches anyone at
 * all, so the dialog says that plainly, and the link can expire.
 */
export function LinkDialog({ entry, onClose }: { entry: FileEntry; onClose: () => void }) {
  const [link, setLink] = useState<LinkSummary | null | undefined>(undefined);
  const [days, setDays] = useState<number | null>(7);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listLinks(entry.path)
      .then(({ links }) => !cancelled && setLink(links[0] ?? null))
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : 'Could not load the link.'));
    return () => {
      cancelled = true;
    };
  }, [entry.path]);

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    work()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'That did not work.'))
      .finally(() => setBusy(false));
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Copying was blocked by the browser. Select the link and copy it instead.');
    }
  };

  return (
    <Scrim onDismiss={onClose}>
      <div className="dialog dialog--link" role="dialog" aria-modal="true" aria-label={`Public link for ${entry.name}`}>
        <h2>Public Link</h2>
        <p>
          Anyone with the link can {entry.isDir ? 'see and download what is in' : 'download'} “{entry.name}” —
          no account needed. Remove the link to stop it working.
        </p>

        {error && (
          <div className="banner" role="alert">
            <Icon name="warning" size={16} />
            <span style={{ flex: 1 }}>{error}</span>
          </div>
        )}

        {link === undefined ? (
          <div className="centred" style={{ height: 80 }}><div className="spinner" /></div>
        ) : link ? (
          <>
            <div className="link__url">
              <input type="text" readOnly value={link.url} onFocus={(event) => event.target.select()} aria-label="Link" />
              <button type="button" className="button button--primary" onClick={() => void copy(link.url)}>
                <Icon name={copied ? 'check' : 'copy'} size={15} />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="link__expiry">
              {link.expiresAt ? `Expires ${formatExactDate(link.expiresAt)}.` : 'Does not expire.'}
            </p>
            <div className="dialog__actions">
              <button
                type="button"
                className="button button--danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.removeLink(link.id);
                    setLink(null);
                  })
                }
              >
                Remove Link
              </button>
              <div style={{ flex: 1 }} />
              <button type="button" className="button" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <label className="link__duration">
              <span>Expires after</span>
              <select value={days ?? ''} onChange={(event) => setDays(event.target.value ? Number(event.target.value) : null)}>
                {LINK_DURATIONS.map((choice) => (
                  <option key={choice.label} value={choice.days ?? ''}>{choice.label}</option>
                ))}
              </select>
            </label>
            <div className="dialog__actions">
              <button type="button" className="button" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const created = await api.saveLink(entry.path, days);
                    setLink(created);
                    await copy(created.url);
                  })
                }
              >
                Create and Copy Link
              </button>
            </div>
          </>
        )}
      </div>
    </Scrim>
  );
}
