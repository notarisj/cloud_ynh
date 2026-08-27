import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Icon, iconForEntry } from './Icon';
import { formatBytes, formatDate, formatExactDate } from '../lib/format';
import { thumbUrl } from '../lib/api';
import type { FileEntry, SortKey } from '../lib/api';

export type ViewMode = 'grid' | 'list';

interface FileBrowserProps {
  entries: FileEntry[];
  ticket: string | null;
  view: ViewMode;
  sort: SortKey;
  descending: boolean;
  selection: Set<string>;
  onSelectionChange: (paths: Set<string>) => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry | null, event: MouseEvent) => void;
  onSortChange: (key: SortKey) => void;
}

export function FileBrowser({
  entries, ticket, view, sort, descending, selection,
  onSelectionChange, onOpen, onContextMenu, onSortChange,
}: FileBrowserProps) {
  // Anchor for shift-click ranges, the way every file manager behaves.
  const anchor = useRef<string | null>(null);

  const select = useCallback(
    (entry: FileEntry, event: MouseEvent) => {
      const next = new Set(selection);

      if (event.shiftKey && anchor.current) {
        const from = entries.findIndex((candidate) => candidate.path === anchor.current);
        const to = entries.findIndex((candidate) => candidate.path === entry.path);
        if (from >= 0 && to >= 0) {
          next.clear();
          for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
            const item = entries[i];
            if (item) next.add(item.path);
          }
          onSelectionChange(next);
          return;
        }
      }

      if (event.metaKey || event.ctrlKey) {
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
      } else {
        next.clear();
        next.add(entry.path);
      }

      anchor.current = entry.path;
      onSelectionChange(next);
    },
    [entries, selection, onSelectionChange],
  );

  const handleContext = (entry: FileEntry, event: MouseEvent) => {
    // Right-clicking outside the selection moves the selection to that item;
    // right-clicking inside it keeps the whole set, so a multi-item action
    // still applies to everything the user had chosen.
    if (!selection.has(entry.path)) {
      onSelectionChange(new Set([entry.path]));
      anchor.current = entry.path;
    }
    onContextMenu(entry, event);
  };

  if (view === 'grid') {
    return (
      <div className="grid" role="listbox" aria-multiselectable="true">
        {entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            role="option"
            className="tile"
            aria-selected={selection.has(entry.path)}
            onClick={(event) => select(entry, event)}
            onDoubleClick={() => onOpen(entry)}
            onContextMenu={(event) => handleContext(entry, event)}
            title={`${entry.name}\n${formatExactDate(entry.mtime)}`}
          >
            <div className="tile__thumb">
              <Thumbnail entry={entry} ticket={ticket} size={84} iconSize={52} />
            </div>
            <div className="tile__name">{entry.name}</div>
            <div className="tile__meta">{entry.isDir ? 'Folder' : formatBytes(entry.size)}</div>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="list" role="listbox" aria-multiselectable="true">
      <div className="list__header" role="presentation">
        <SortHeader label="Name" column="name" sort={sort} descending={descending} onSortChange={onSortChange} />
        <SortHeader label="Size" column="size" sort={sort} descending={descending} onSortChange={onSortChange} />
        <SortHeader label="Modified" column="mtime" sort={sort} descending={descending} onSortChange={onSortChange} />
        <span />
      </div>

      {entries.map((entry) => (
        <button
          key={entry.path}
          type="button"
          role="option"
          className="row"
          aria-selected={selection.has(entry.path)}
          onClick={(event) => select(entry, event)}
          onDoubleClick={() => onOpen(entry)}
          onContextMenu={(event) => handleContext(entry, event)}
        >
          <span className="row__name">
            <span className="row__icon">
              <Thumbnail entry={entry} ticket={ticket} size={22} iconSize={19} />
            </span>
            <span title={entry.name}>{entry.name}</span>
          </span>
          <span className="row__meta row__meta--right">{entry.isDir ? '—' : formatBytes(entry.size)}</span>
          <span className="row__meta" title={formatExactDate(entry.mtime)}>{formatDate(entry.mtime)}</span>
          <span
            className="iconbutton"
            role="presentation"
            onClick={(event) => {
              event.stopPropagation();
              handleContext(entry, event);
            }}
          >
            <Icon name="ellipsis" size={16} weight={2.4} />
          </span>
        </button>
      ))}
    </div>
  );
}

function SortHeader({
  label, column, sort, descending, onSortChange,
}: {
  label: string;
  column: SortKey;
  sort: SortKey;
  descending: boolean;
  onSortChange: (key: SortKey) => void;
}) {
  const active = sort === column;
  return (
    <button
      type="button"
      onClick={() => onSortChange(column)}
      style={{ justifySelf: column === 'size' ? 'end' : 'start', color: active ? 'var(--text)' : undefined }}
      aria-sort={active ? (descending ? 'descending' : 'ascending') : 'none'}
    >
      {label}
      {active && (
        <Icon name="chevronDown" size={12} weight={2.4} style={descending ? undefined : { transform: 'rotate(180deg)' }} />
      )}
    </button>
  );
}

/**
 * A real thumbnail where the server can make one, the type glyph otherwise.
 *
 * The image is only requested once it scrolls near the viewport: a folder of a
 * thousand photos would otherwise open a thousand connections at once and
 * spend the server's whole preview budget on images nobody looked at.
 */
function Thumbnail({
  entry, ticket, size, iconSize,
}: {
  entry: FileEntry;
  ticket: string | null;
  size: number;
  iconSize: number;
}) {
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const holder = useRef<HTMLSpanElement>(null);

  const wanted = entry.hasThumbnail && ticket !== null && !failed;

  useEffect(() => {
    if (!wanted || visible) return;
    const element = holder.current;
    if (!element) return;

    // No IntersectionObserver (very old browsers): just load it.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '320px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [wanted, visible]);

  // A changed etag means new bytes, so it belongs in the URL to bust the cache.
  const source = wanted && visible && ticket ? thumbUrl(ticket, entry.path, size <= 32 ? 128 : 256) : null;
  const { name, tint } = iconForEntry(entry);

  return (
    <span ref={holder} style={{ display: 'grid', placeItems: 'center', width: size, height: size }}>
      {source ? (
        <img
          src={`${source}&v=${entry.etag}`}
          alt=""
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon name={name} size={iconSize} weight={1.4} style={{ color: tint }} />
      )}
    </span>
  );
}
