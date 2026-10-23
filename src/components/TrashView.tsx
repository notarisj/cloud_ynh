import { useEffect, useState } from 'react';
import { Checkbox } from './FileBrowser';
import { Icon, iconForEntry } from './Icon';
import { formatBytes, formatDate } from '../lib/format';
import type { TrashItem } from '../lib/api';

interface TrashViewProps {
  items: TrashItem[];
  retentionDays: number;
  onRestore: (items: TrashItem[]) => void;
  onPurge: (items: TrashItem[]) => void;
}

/**
 * Recently Deleted. One item can be put back or removed from its row; several
 * are picked with the checkboxes and handled together from the bar that
 * appears — the same two actions, on the same selection, as the iOS app.
 */
export function TrashView({ items, retentionDays, onRestore, onPurge }: TrashViewProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // A refreshed list can retire items that were ticked.
  useEffect(() => {
    setSelected((current) => new Set([...current].filter((id) => items.some((item) => item.id === id))));
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="empty">
        <Icon name="trash" size={48} weight={1.2} />
        <h2>Nothing deleted</h2>
        <p>Items you delete are kept here for {retentionDays} days before being removed for good.</p>
      </div>
    );
  }

  const chosen = items.filter((item) => selected.has(item.id));
  const allSelected = chosen.length === items.length;
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <div className={`list${selected.size > 0 ? ' list--picking' : ''}`}>
        <div className="list__header" role="presentation">
          <span className="list__check">
            <Checkbox
              checked={allSelected}
              label={allSelected ? 'Deselect all' : 'Select all'}
              onToggle={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))}
            />
          </span>
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
            <div
              key={item.id}
              className="row"
              aria-selected={selected.has(item.id)}
              onClick={() => toggle(item.id)}
            >
              <span className="list__check">
                <Checkbox checked={selected.has(item.id)} label={item.name} onToggle={() => toggle(item.id)} />
              </span>
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
              <span style={{ display: 'flex', gap: 2 }} onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="iconbutton"
                  onClick={() => onRestore([item])}
                  aria-label={`Put ${item.name} back`}
                  title="Put back"
                >
                  <Icon name="restore" size={16} />
                </button>
                <button
                  type="button"
                  className="iconbutton"
                  onClick={() => onPurge([item])}
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

      {chosen.length > 0 && (
        <div className="selbar" role="toolbar" aria-label={`${chosen.length} selected`}>
          <button type="button" className="iconbutton selbar__close" onClick={() => setSelected(new Set())} aria-label="Deselect">
            <Icon name="close" size={17} />
          </button>
          <span className="selbar__count">{chosen.length} selected</span>
          <div className="selbar__actions">
            <button type="button" className="selbar__action" onClick={() => onRestore(chosen)}>
              <Icon name="restore" size={16} />
              <span>Put Back</span>
            </button>
            <button type="button" className="selbar__action selbar__action--danger" onClick={() => onPurge(chosen)}>
              <Icon name="trash" size={16} />
              <span>Delete</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
