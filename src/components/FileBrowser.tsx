import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
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
  /** True in Shared and in search results: show where each item came from. */
  showOwner?: boolean;
  onSelectionChange: (paths: Set<string>) => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry | null, event: MouseEvent) => void;
  onSortChange: (key: SortKey) => void;
}

/**
 * Whether the primary pointer is a finger.
 *
 * It decides the whole interaction model: with a mouse, a click selects and a
 * double-click opens, the way every file manager has always worked. On a touch
 * screen there is no double-tap worth designing for, so a tap opens and
 * selection happens through the checkboxes — which are always visible there
 * rather than appearing on hover, because there is no hover either.
 */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true,
  );

  useEffect(() => {
    const query = window.matchMedia?.('(pointer: coarse)');
    if (!query) return;
    const update = () => setCoarse(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return coarse;
}

export function FileBrowser({
  entries, ticket, view, sort, descending, selection, showOwner,
  onSelectionChange, onOpen, onContextMenu, onSortChange,
}: FileBrowserProps) {
  // Anchor for shift-click ranges, the way every file manager behaves.
  const anchor = useRef<string | null>(null);
  const coarse = useCoarsePointer();

  const allSelected = entries.length > 0 && entries.every((entry) => selection.has(entry.path));

  const toggle = useCallback(
    (entry: FileEntry) => {
      const next = new Set(selection);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      anchor.current = entry.path;
      onSelectionChange(next);
    },
    [selection, onSelectionChange],
  );

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

  /** A plain click: open on touch, select with a mouse. */
  const activate = useCallback(
    (entry: FileEntry, event: MouseEvent) => {
      if (coarse && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        // With something already selected, tapping extends the selection
        // instead of navigating away from it.
        if (selection.size > 0) toggle(entry);
        else onOpen(entry);
        return;
      }
      select(entry, event);
    },
    [coarse, selection.size, toggle, onOpen, select],
  );

  const handleContext = (entry: FileEntry, event: MouseEvent) => {
    // The folder background has its own menu — New Folder, Upload, Paste — and
    // it is listening on an ancestor. Without this the menu for the item is
    // built and then immediately replaced by the background's, so right-click
    // on a file appears to do the wrong thing entirely.
    event.stopPropagation();

    // Right-clicking outside the selection moves the selection to that item;
    // right-clicking inside it keeps the whole set, so a multi-item action
    // still applies to everything the user had chosen.
    if (!selection.has(entry.path)) {
      onSelectionChange(new Set([entry.path]));
      anchor.current = entry.path;
    }
    onContextMenu(entry, event);
  };

  const surface = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  /**
   * Rubber-band selection, the way a desktop does it: press on empty space,
   * drag, and everything the rectangle touches is selected.
   *
   * The threshold matters. Without it every click on the background starts a
   * one-pixel drag, and a plain click — which is how you *clear* a selection —
   * would be swallowed by it. Four pixels is below what a hand does by
   * accident and above what a mouse does on its own.
   */
  const startMarquee = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // A finger dragging across the background is scrolling, not selecting.
      if (event.pointerType !== 'mouse') return;

      // A press that starts on a row, a tile or any control belongs to that
      // thing, not to the background.
      const target = event.target as HTMLElement;
      if (target.closest('.row, .tile, button, a, input, .list__header')) return;

      const host = surface.current;
      if (!host) return;

      const originX = event.clientX;
      const originY = event.clientY;
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const before = new Set(selection);
      let dragging = false;

      const move = (pointer: PointerEvent) => {
        const dx = pointer.clientX - originX;
        const dy = pointer.clientY - originY;
        if (!dragging && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        dragging = true;

        const rect = {
          left: Math.min(originX, pointer.clientX),
          top: Math.min(originY, pointer.clientY),
          right: Math.max(originX, pointer.clientX),
          bottom: Math.max(originY, pointer.clientY),
        };

        // Drawn relative to the surface, compared in viewport coordinates —
        // which keeps it honest when the list is scrolled mid-drag.
        const hostBox = host.getBoundingClientRect();
        setBox({
          left: rect.left - hostBox.left,
          top: rect.top - hostBox.top,
          width: rect.right - rect.left,
          height: rect.bottom - rect.top,
        });

        const next = additive ? new Set(before) : new Set<string>();
        for (const element of host.querySelectorAll<HTMLElement>('[data-path]')) {
          const item = element.getBoundingClientRect();
          const touches =
            item.left < rect.right &&
            item.right > rect.left &&
            item.top < rect.bottom &&
            item.bottom > rect.top;
          if (touches) next.add(element.dataset.path!);
        }
        onSelectionChange(next);
      };

      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        // A press that never became a drag is a click on the background, and
        // that means "deselect everything".
        if (!dragging && !additive) onSelectionChange(new Set());
        setBox(null);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [selection, onSelectionChange],
  );

  const badges = useMemo(
    () => (entry: FileEntry) => (
      <>
        {entry.shared && !showOwner && (
          <span className="badge badge--shared" title="Shared with everyone">
            <Icon name="shared" size={13} />
          </span>
        )}
        {entry.readOnly && (
          <span className="badge" title={`Shared by ${entry.sharedBy ?? 'someone else'} · read only`}>
            <Icon name="info" size={13} />
          </span>
        )}
      </>
    ),
    [showOwner],
  );

  const body =
    view === 'grid' ? (
      <div className={`grid${coarse || selection.size > 0 ? ' grid--picking' : ''}`} role="listbox" aria-multiselectable="true">
        {entries.map((entry) => (
          <div
            key={entry.path}
            data-path={entry.path}
            role="option"
            tabIndex={0}
            className="tile"
            aria-selected={selection.has(entry.path)}
            onClick={(event) => activate(entry, event)}
            onDoubleClick={() => !coarse && onOpen(entry)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen(entry);
              }
            }}
            onContextMenu={(event) => handleContext(entry, event)}
            title={`${entry.name}\n${formatExactDate(entry.mtime)}`}
          >
            <Checkbox
              checked={selection.has(entry.path)}
              label={entry.name}
              onToggle={() => toggle(entry)}
            />
            <div className="tile__thumb">
              <Thumbnail entry={entry} ticket={ticket} size={84} iconSize={52} />
            </div>
            <div className="tile__name">
              {entry.name}
              {badges(entry)}
            </div>
            <div className="tile__meta">
              {entry.isDir ? 'Folder' : formatBytes(entry.size)}
              {showOwner && entry.sharedBy && ` · ${entry.sharedBy}`}
            </div>
          </div>
        ))}
      </div>
    ) : (
      <div className={`list${coarse || selection.size > 0 ? ' list--picking' : ''}`} role="listbox" aria-multiselectable="true">
      <div className="list__header" role="presentation">
        <span className="list__check">
          <Checkbox
            checked={allSelected}
            label={allSelected ? 'Deselect all' : 'Select all'}
            onToggle={() =>
              onSelectionChange(allSelected ? new Set() : new Set(entries.map((entry) => entry.path)))
            }
          />
        </span>
        <SortHeader label="Name" column="name" sort={sort} descending={descending} onSortChange={onSortChange} />
        <SortHeader label="Size" column="size" sort={sort} descending={descending} onSortChange={onSortChange} />
        <SortHeader label="Modified" column="mtime" sort={sort} descending={descending} onSortChange={onSortChange} />
        <span />
      </div>

      {entries.map((entry) => (
        <div
          key={entry.path}
          data-path={entry.path}
          role="option"
          tabIndex={0}
          className="row"
          aria-selected={selection.has(entry.path)}
          onClick={(event) => activate(entry, event)}
          onDoubleClick={() => !coarse && onOpen(entry)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpen(entry);
            }
          }}
          onContextMenu={(event) => handleContext(entry, event)}
        >
          <span className="list__check">
            <Checkbox
              checked={selection.has(entry.path)}
              label={entry.name}
              onToggle={() => toggle(entry)}
            />
          </span>

          <span className="row__name">
            <span className="row__icon">
              <Thumbnail entry={entry} ticket={ticket} size={22} iconSize={19} />
            </span>
            <span title={entry.name}>{entry.name}</span>
            {badges(entry)}
            {/* Whose item this is belongs next to its name, not in place of
                the date: the Modified column has a header that says what it
                holds, and swapping its contents would make that header lie. */}
            {showOwner && entry.sharedBy && (
              <span className="row__owner">shared by {entry.sharedBy}</span>
            )}
          </span>

          <span className="row__meta row__meta--right">{entry.isDir ? '—' : formatBytes(entry.size)}</span>
          <span className="row__meta" title={formatExactDate(entry.mtime)}>{formatDate(entry.mtime)}</span>

          <button
            type="button"
            className="iconbutton"
            aria-label={`Actions for ${entry.name}`}
            onClick={(event) => {
              event.stopPropagation();
              handleContext(entry, event);
            }}
          >
            <Icon name="ellipsis" size={16} weight={2.4} />
          </button>
        </div>
      ))}
      </div>
    );

  return (
    <div ref={surface} className="browser" onPointerDown={startMarquee}>
      {body}
      {box && (
        <div
          className="marquee"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      )}
    </div>
  );
}

/**
 * The selection checkbox. A real button rather than an <input> so that it can
 * live inside a row without the click reaching the row underneath.
 */
function Checkbox({
  checked, label, onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="check"
      role="checkbox"
      aria-checked={checked}
      aria-label={`Select ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {checked && <Icon name="check" size={12} weight={3} />}
    </button>
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
