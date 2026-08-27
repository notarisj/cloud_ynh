import { Icon } from './Icon';
import { formatBytes } from '../lib/format';
import type { FileEntry } from '../lib/api';

interface SelectionBarProps {
  selected: FileEntry[];
  /** False in Shared and in search results, where there is nothing to write to. */
  writable: boolean;
  onDownload: () => void;
  onShare: () => void;
  onUnshare: () => void;
  onMove: () => void;
  onCopy: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClear: () => void;
}

/**
 * The action bar for a selection.
 *
 * A context menu is only discoverable if you already know to right-click, and
 * on a touch screen it barely exists. So the moment anything is selected, the
 * things you can do to it appear in one place — and the bar says how much is
 * selected, which is the question people actually have before they hit Delete.
 */
export function SelectionBar({
  selected, writable, onDownload, onShare, onUnshare, onMove, onCopy, onRename, onDelete, onClear,
}: SelectionBarProps) {
  if (selected.length === 0) return null;

  const one = selected.length === 1 ? selected[0] : null;
  const files = selected.filter((entry) => !entry.isDir);
  const bytes = files.reduce((total, entry) => total + entry.size, 0);

  // Sharing is all-or-nothing on the selection: mixing "share these two" with
  // "unshare that one" in a single button would be a coin toss. Only the top
  // of a share can be unshared, and only an item of your own that is not
  // already published can be shared.
  const canShare = selected.every((entry) => !entry.readOnly && !entry.sharedBy && !entry.shared);
  const canUnshare = selected.every((entry) => entry.shared && !entry.readOnly);

  return (
    <div className="selbar" role="toolbar" aria-label={`${selected.length} selected`}>
      <button type="button" className="iconbutton selbar__close" onClick={onClear} aria-label="Deselect">
        <Icon name="close" size={17} />
      </button>

      <span className="selbar__count">
        {selected.length} selected
        {bytes > 0 && <span className="selbar__bytes"> · {formatBytes(bytes)}</span>}
      </span>

      <div className="selbar__actions">
        <Action
          icon="download"
          label={files.length > 1 ? `Download ${files.length}` : 'Download'}
          onClick={onDownload}
          disabled={files.length === 0}
          title={files.length === 0 ? 'Folders cannot be downloaded' : undefined}
        />

        {canShare && writable && <Action icon="shared" label="Share" onClick={onShare} />}
        {canUnshare && <Action icon="shared" label="Stop sharing" onClick={onUnshare} active />}

        <Action icon="copy" label="Copy to…" onClick={onCopy} />
        {writable && <Action icon="move" label="Move to…" onClick={onMove} />}
        {writable && <Action icon="pencil" label="Rename" onClick={onRename} disabled={one === null} />}
        {writable && <Action icon="trash" label="Delete" onClick={onDelete} danger />}
      </div>
    </div>
  );
}

function Action({
  icon, label, onClick, disabled, danger, active, title,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`selbar__action${danger ? ' selbar__action--danger' : ''}${active ? ' selbar__action--active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      <Icon name={icon} size={16} />
      <span>{label}</span>
    </button>
  );
}
