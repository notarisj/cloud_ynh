import { Icon, iconForEntry } from './Icon';
import { formatBytes, formatDate } from '../lib/format';
import type { TrashItem } from '../lib/api';

interface TrashViewProps {
  items: TrashItem[];
  retentionDays: number;
  onRestore: (item: TrashItem) => void;
  onPurge: (item: TrashItem) => void;
}

export function TrashView({ items, retentionDays, onRestore, onPurge }: TrashViewProps) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <Icon name="trash" size={48} weight={1.2} />
        <h2>Nothing deleted</h2>
        <p>Items you delete are kept here for {retentionDays} days before being removed for good.</p>
      </div>
    );
  }

  return (
    <div className="list">
      <div className="list__header" role="presentation">
        <span>Name</span>
        <span style={{ justifySelf: 'end' }}>Size</span>
        <span>Deleted</span>
        <span />
      </div>

      {items.map((item) => {
        const { name, tint } = iconForEntry({ isDir: item.isDir, name: item.name, preview: null });
        const daysLeft = Math.max(
          0,
          Math.ceil((item.deletedAt + retentionDays * 86_400_000 - Date.now()) / 86_400_000),
        );

        return (
          <div key={item.id} className="row" style={{ cursor: 'default' }}>
            <span className="row__name">
              <span className="row__icon">
                <Icon name={name} size={19} weight={1.4} style={{ color: tint }} />
              </span>
              <span title={`Was in ${item.originalPath}`}>{item.name}</span>
            </span>
            <span className="row__meta row__meta--right">{item.isDir ? '—' : formatBytes(item.size)}</span>
            <span className="row__meta" title={`Removed for good in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`}>
              {formatDate(item.deletedAt)}
            </span>
            <span style={{ display: 'flex', gap: 2 }}>
              <button
                type="button"
                className="iconbutton"
                onClick={() => onRestore(item)}
                aria-label={`Put ${item.name} back`}
                title="Put back"
              >
                <Icon name="restore" size={16} />
              </button>
              <button
                type="button"
                className="iconbutton"
                onClick={() => onPurge(item)}
                aria-label={`Delete ${item.name} permanently`}
                title="Delete permanently"
              >
                <Icon name="trash" size={16} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
