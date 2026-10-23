import { useEffect, useState } from 'react';
import { Scrim } from './Dialogs';
import { Icon, iconForEntry } from './Icon';
import * as api from '../lib/api';
import type { Contents, FileEntry } from '../lib/api';
import { formatBytes, formatExactDate, kindLabel, locationLabel } from '../lib/format';

interface InfoDialogProps {
  entry: FileEntry;
  /** Read ticket for the folder the entry was shown in, for its thumbnail. */
  ticket: string | null;
  rootLabels: Record<string, string>;
  onClose: () => void;
}

/**
 * Get Info: the questions a list row cannot answer — how big a folder really
 * is, where something lives, when it was made, who can see it. The same
 * fields, in the same order, as the iOS app's Info sheet.
 */
export function InfoDialog({ entry, ticket, rootLabels, onClose }: InfoDialogProps) {
  const [contents, setContents] = useState<Contents | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .info(entry.path)
      .then((result) => !cancelled && setContents(result.contents))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [entry.path]);

  const { name, tint } = iconForEntry(entry);
  const size = entry.isDir
    ? contents
      ? `${formatBytes(contents.size)}${contents.complete ? '' : '+'} · ${itemCount(contents)}`
      : failed ? '—' : 'Calculating…'
    : formatBytes(entry.size);

  return (
    <Scrim onDismiss={onClose}>
      <div className="dialog dialog--info" role="dialog" aria-modal="true" aria-label={`Info for ${entry.name}`}>
        <div className="info__hero">
          {entry.hasThumbnail && ticket ? (
            <img src={api.thumbUrl(ticket, entry.path, 256)} alt="" className="info__thumb" />
          ) : (
            <Icon name={name} size={56} weight={1.2} style={{ color: tint }} />
          )}
          <h2>{entry.name}</h2>
          <span className="info__kind">{kindLabel(entry)}</span>
        </div>

        <dl className="info__facts">
          <dt>Size</dt>
          <dd>{size}</dd>
          <dt>Where</dt>
          <dd>{locationLabel(entry.path, rootLabels)}</dd>
          <dt>Created</dt>
          <dd>{formatExactDate(entry.ctime)}</dd>
          <dt>Modified</dt>
          <dd>{formatExactDate(entry.mtime)}</dd>
          {(entry.shared || entry.sharedBy) && (
            <>
              <dt>Sharing</dt>
              <dd>
                {entry.sharedBy && entry.readOnly
                  ? `Shared by ${entry.sharedBy} · read only`
                  : `Shared with everyone as “${entry.sharedAs?.split('/').pop() ?? entry.name}”`}
              </dd>
            </>
          )}
        </dl>

        <div className="dialog__actions">
          <button type="button" className="button button--primary" onClick={onClose} autoFocus>Done</button>
        </div>
      </div>
    </Scrim>
  );
}

function itemCount(contents: Contents): string {
  const count = contents.files + contents.folders;
  const label = count === 1 ? '1 item' : `${count.toLocaleString()} items`;
  return contents.complete ? label : `${label} counted so far`;
}
