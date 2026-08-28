import {
  useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent,
} from 'react';
import * as api from './lib/api';
import { ApiError, SessionExpiredError } from './lib/api';
import type { FileEntry, Listing, Session, SortKey, TrashItem } from './lib/api';
import { breadcrumbs, splitExtension } from './lib/format';
import { loadPreferences, savePreferences } from './lib/prefs';
import { filesFromDrop, uploads } from './lib/uploads';
import { ContextMenu, type MenuAction } from './components/ContextMenu';
import { ConfirmDialog, PromptDialog } from './components/Dialogs';
import { FileBrowser, type ViewMode } from './components/FileBrowser';
import { FolderPicker } from './components/FolderPicker';
import { Icon } from './components/Icon';
import { PreviewOverlay } from './components/PreviewOverlay';
import { SelectionBar } from './components/SelectionBar';
import { SettingsPanel } from './components/SettingsPanel';
import { ShareDialog } from './components/ShareDialog';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { TrashView } from './components/TrashView';
import { UploadTray } from './components/UploadTray';
import { UsersView } from './components/UsersView';

type View = 'browse' | 'trash' | 'search';

/** Clipboard for cut/copy, held only for the lifetime of the page. */
interface Clipboard {
  paths: string[];
  operation: 'copy' | 'cut';
}

type Dialog =
  | { kind: 'newFolder' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'confirmDelete'; entries: FileEntry[] }
  | { kind: 'confirmPurge'; item: TrashItem }
  | { kind: 'confirmEmptyTrash' }
  | { kind: 'pick'; operation: 'move' | 'copy'; entries: FileEntry[] }
  | { kind: 'share'; entries: FileEntry[] }
  | null;

//=================================================
// Hash routing
//=================================================
// The app lives under whatever sub-path YunoHost installed it at, so a
// history-based router would need that path threaded through everything. The
// hash carries the location instead: it survives reloads, makes folders
// linkable, and is completely indifferent to the mount point.

function readHash(): { view: View; path: string; query: string } {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash === 'trash') return { view: 'trash', path: '/me', query: '' };
  if (hash.startsWith('search=')) {
    return { view: 'search', path: '/me', query: decodeURIComponent(hash.slice(7)) };
  }
  const path = hash.startsWith('/') ? decodeURI(hash) : '/me';
  return { view: 'browse', path, query: '' };
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [signedOut, setSignedOut] = useState(false);

  const initial = useMemo(readHash, []);
  const [view, setView] = useState<View>(initial.view);
  const [path, setPath] = useState(initial.path);
  const [query, setQuery] = useState(initial.query);

  const [listing, setListing] = useState<Listing | null>(null);
  const [searchResults, setSearchResults] = useState<{ results: FileEntry[]; ticket: string } | null>(null);
  const [trash, setTrash] = useState<{ items: TrashItem[]; retentionDays: number } | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);

  const preferences = useMemo(loadPreferences, []);
  const [viewMode, setViewMode] = useState<ViewMode>(preferences.view);
  const [sort, setSort] = useState<SortKey>(preferences.sort);
  const [descending, setDescending] = useState(preferences.descending);

  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);

  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  // Nested dragenter/dragleave pairs fire constantly; counting them is the
  // only reliable way to know when the pointer has really left the window.
  const dragDepth = useRef(0);

  useEffect(() => savePreferences({ view: viewMode, sort, descending }), [viewMode, sort, descending]);

  // Notices are transient by nature — they explain something that just
  // happened, and they should not outlive the user's attention.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  //=================================================
  // Session
  //=================================================

  const openSession = useCallback((attempt = 0) => {
    api
      .getSession()
      .then((value) => {
        setSession(value);
        setExpired(false);
        setSignedOut(false);
        setFatal(null);
      })
      .catch((cause: unknown) => {
        if (cause instanceof SessionExpiredError) {
          setSignedOut(true);
          return;
        }

        // The API can simply not be listening yet — a reverse proxy that came
        // up first, or `npm run dev` where the web server starts in a third of
        // the time the API takes to compile. Retrying briefly turns that from
        // an error screen into a slightly slower first paint.
        const unreachable = cause instanceof ApiError && cause.code === 'unreachable';
        if (unreachable && attempt < 3) {
          window.setTimeout(() => openSession(attempt + 1), 1200);
          return;
        }

        setFatal(cause instanceof Error ? cause.message : 'Could not reach the server.');
      });
  }, []);

  useEffect(() => openSession(), [openSession]);

  const rootLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const root of session?.roots ?? []) labels[root.id] = root.name;
    return labels;
  }, [session]);

  //=================================================
  // Loading
  //=================================================

  const reportError = useCallback((cause: unknown) => {
    if (cause instanceof SessionExpiredError) {
      setExpired(true);
      return;
    }
    setError(cause instanceof ApiError ? cause.message : 'Something went wrong.');
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    setError(null);

    try {
      if (view === 'trash') {
        setTrash(await api.listTrash());
      } else if (view === 'search') {
        if (query.trim().length < 2) {
          setSearchResults({ results: [], ticket: '' });
        } else {
          const found = await api.search(query.trim());
          setSearchResults({ results: found.results, ticket: found.ticket.token });
        }
      } else {
        setListing(await api.list(path, sort, descending));
      }
    } catch (cause) {
      reportError(cause);
    } finally {
      setLoading(false);
    }
  }, [session, view, path, query, sort, descending, reportError]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Keep the address bar in step with the current location.
  useEffect(() => {
    const hash =
      view === 'trash' ? '#trash' : view === 'search' ? `#search=${encodeURIComponent(query)}` : `#${encodeURI(path)}`;
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }, [view, path, query]);

  // Back and forward buttons.
  useEffect(() => {
    const onHashChange = () => {
      const next = readHash();
      setView(next.view);
      setPath(next.path);
      setQuery(next.query);
      setSelection(new Set());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const refreshUsage = useCallback(() => {
    api
      .usage()
      .then((usage) => setSession((current) => (current ? { ...current, usage } : current)))
      .catch(() => undefined);
  }, []);

  //=================================================
  // Navigation
  //=================================================

  const navigate = useCallback((target: string) => {
    setView('browse');
    setPath(target);
    setQuery('');
    setSelection(new Set());
    setSidebarOpen(false);
  }, []);

  const entries = view === 'search' ? (searchResults?.results ?? []) : (listing?.entries ?? []);
  const ticket = view === 'search' ? (searchResults?.ticket ?? null) : (listing?.ticket.token ?? null);
  const previewable = useMemo(() => entries.filter((entry) => !entry.isDir), [entries]);

  // Shared is a view of what other people published, so nothing can be written
  // into it. The server is the authority; this is what the toolbar reads.
  const writable = view === 'browse' && (listing?.writable ?? path.startsWith('/me'));

  const open = useCallback(
    (entry: FileEntry) => {
      if (entry.isDir) {
        navigate(entry.path);
        return;
      }
      const index = previewable.findIndex((candidate) => candidate.path === entry.path);
      if (index >= 0) setPreviewIndex(index);
    },
    [navigate, previewable],
  );

  //=================================================
  // Actions
  //=================================================

  const selected = useMemo(
    () => entries.filter((entry) => selection.has(entry.path)),
    [entries, selection],
  );

  const parentOf = (target: string) => target.split('/').slice(0, -1).join('/') || '/me';

  const runAction = useCallback(
    async (work: () => Promise<unknown>) => {
      setError(null);
      try {
        await work();
        await refresh();
        refreshUsage();
      } catch (cause) {
        reportError(cause);
      }
    },
    [refresh, refreshUsage, reportError],
  );

  const doDelete = (targets: FileEntry[]) =>
    runAction(async () => {
      for (const target of targets) await api.remove(target.path);
      setSelection(new Set());
    });

  const doShare = (targets: FileEntry[], visibility: 'all' | 'users' = 'all', sharedWith: string[] = []) =>
    runAction(async () => {
      for (const target of targets) await api.share(target.path, visibility, sharedWith);
      setNotice(
        targets.length === 1
          ? `“${targets[0]?.name}” is now in Shared. It stays in My Files.`
          : `${targets.length} items are now in Shared. They stay in My Files.`,
      );
    });

  const doUnshare = (targets: FileEntry[]) =>
    runAction(async () => {
      for (const target of targets) await api.unshare(target.path);
      setNotice('Removed from Shared. Nothing was deleted.');
    });

  /** Move or copy a set of items into a folder the user just picked. */
  const doTransfer = (operation: 'move' | 'copy', targets: FileEntry[], destination: string) =>
    runAction(async () => {
      for (const target of targets) {
        const to = `${destination}/${target.name}`;
        if (to === target.path) continue;
        if (operation === 'move') await api.move(target.path, to, 'rename');
        else await api.copy(target.path, to, 'rename');
      }
      setSelection(new Set());
      setNotice(
        `${targets.length === 1 ? '1 item' : `${targets.length} items`} ${
          operation === 'move' ? 'moved' : 'copied'
        } to ${destination === '/me' ? 'My Files' : destination.split('/').pop()}.`,
      );
    });

  const doPaste = useCallback(() => {
    if (!clipboard || view !== 'browse' || !writable) return;
    void runAction(async () => {
      for (const source of clipboard.paths) {
        const name = source.split('/').pop() ?? '';
        const destination = `${path}/${name}`;
        if (destination === source) continue;
        if (clipboard.operation === 'cut') await api.move(source, destination, 'rename');
        else await api.copy(source, destination, 'rename');
      }
      if (clipboard.operation === 'cut') setClipboard(null);
    });
  }, [clipboard, view, writable, runAction, path]);

  const download = useCallback(
    (targets: FileEntry[]) => {
      if (!ticket) return;
      const files = targets.filter((entry) => !entry.isDir);
      if (files.length === 0) {
        setNotice('Folders cannot be downloaded yet — open one and download what is inside.');
        return;
      }
      // Browsers throttle a burst of navigations, so the downloads are started
      // as separate hidden links, spaced just enough to all be honoured.
      files.forEach((entry, index) => {
        window.setTimeout(() => {
          const link = document.createElement('a');
          link.href = api.downloadUrl(ticket, entry.path);
          link.download = entry.name;
          link.rel = 'noopener';
          document.body.appendChild(link);
          link.click();
          link.remove();
        }, index * 350);
      });
    },
    [ticket],
  );

  const startUpload = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      // Everything lands in My Files. Uploading "into" Shared would put a file
      // somewhere its owner cannot find it again.
      const destination = view === 'browse' && writable ? path : '/me';
      if (destination !== path) {
        setNotice('Uploads go to My Files. Share them from there to publish them.');
      }
      uploads.enqueue(files, destination);
    },
    [view, path, writable],
  );

  //=================================================
  // Drag and drop
  //=================================================

  const onDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (view === 'trash') return;
    startUpload(await filesFromDrop(event.dataTransfer));
  };

  //=================================================
  // Keyboard
  //=================================================

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal a keystroke that belongs to a text field.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (dialog || previewIndex !== null || settingsOpen) return;

      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelection(new Set(entries.map((entry) => entry.path)));
        return;
      }
      if (meta && event.key.toLowerCase() === 'c' && selected.length > 0) {
        setClipboard({ paths: selected.map((entry) => entry.path), operation: 'copy' });
        return;
      }
      if (meta && event.key.toLowerCase() === 'x' && selected.length > 0 && writable) {
        setClipboard({ paths: selected.map((entry) => entry.path), operation: 'cut' });
        return;
      }
      if (meta && event.key.toLowerCase() === 'v') {
        doPaste();
        return;
      }
      if (event.key === 'Escape') {
        setSelection(new Set());
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected.length > 0 && writable) {
        event.preventDefault();
        setDialog({ kind: 'confirmDelete', entries: selected });
        return;
      }
      if (event.key === 'Enter' && selected.length === 1 && selected[0]) {
        event.preventDefault();
        open(selected[0]);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, previewIndex, settingsOpen, entries, selected, writable, doPaste, open]);

  //=================================================
  // Menu
  //=================================================

  const menuActions = useMemo((): MenuAction[] => {
    if (!menu) return [];

    if (menu.entry === null) {
      return [
        { id: 'newFolder', label: 'New Folder', icon: 'folderPlus', disabled: !writable },
        { id: 'upload', label: 'Upload Files…', icon: 'upload' },
        { id: 'uploadFolder', label: 'Upload Folder…', icon: 'folder' },
        {
          id: 'paste',
          label: 'Paste Item',
          icon: 'copy',
          disabled: clipboard === null || !writable,
          separatorBefore: true,
        },
        { id: 'refresh', label: 'Refresh', icon: 'refresh', separatorBefore: true },
      ];
    }

    const many = selected.length > 1;
    const entry = menu.entry;
    // "Mine" means the bytes are the caller's own: not read-only, and not seen
    // through somebody else's share.
    const mine = !entry.readOnly && !entry.sharedBy;
    const actions: MenuAction[] = [
      { id: 'open', label: entry.isDir ? 'Open' : 'Preview', icon: entry.isDir ? 'folder' : 'photo', disabled: many },
      { id: 'download', label: 'Download', icon: 'download', disabled: entry.isDir },
    ];

    if (entry.shared && !entry.readOnly) {
      actions.push({ id: 'unshare', label: 'Stop Sharing', icon: 'shared', separatorBefore: true });
    } else if (mine) {
      actions.push({ id: 'share', label: 'Share with Everyone', icon: 'shared', separatorBefore: true });
    }

    actions.push(
      { id: 'copyTo', label: 'Copy to…', icon: 'copy', separatorBefore: true },
    );

    if (writable && mine) {
      actions.push(
        { id: 'moveTo', label: 'Move to…', icon: 'move' },
        { id: 'rename', label: 'Rename…', icon: 'pencil', disabled: many },
        { id: 'copy', label: many ? `Copy ${selected.length} Items` : 'Copy', icon: 'copy', separatorBefore: true },
        { id: 'cut', label: many ? `Cut ${selected.length} Items` : 'Cut', icon: 'move' },
        {
          id: 'delete',
          label: many ? `Delete ${selected.length} Items` : 'Delete',
          icon: 'trash',
          danger: true,
          separatorBefore: true,
        },
      );
    }

    return actions;
  }, [menu, selected, clipboard, writable]);

  const targets = () => (selected.length > 0 ? selected : menu?.entry ? [menu.entry] : []);

  const onMenuSelect = (id: string) => {
    const entry = menu?.entry;
    switch (id) {
      case 'newFolder': setDialog({ kind: 'newFolder' }); break;
      case 'upload': filePicker.current?.click(); break;
      case 'uploadFolder': folderPicker.current?.click(); break;
      case 'paste': doPaste(); break;
      case 'refresh': void refresh(); break;
      case 'open': if (entry) open(entry); break;
      case 'download': download(targets()); break;
      case 'share': setDialog({ kind: 'share', entries: targets() }); break;
      case 'unshare': void doUnshare(targets()); break;
      case 'copyTo': setDialog({ kind: 'pick', operation: 'copy', entries: targets() }); break;
      case 'moveTo': setDialog({ kind: 'pick', operation: 'move', entries: targets() }); break;
      case 'rename': if (entry) setDialog({ kind: 'rename', entry }); break;
      case 'copy': setClipboard({ paths: targets().map((e) => e.path), operation: 'copy' }); break;
      case 'cut': setClipboard({ paths: targets().map((e) => e.path), operation: 'cut' }); break;
      case 'delete': setDialog({ kind: 'confirmDelete', entries: targets() }); break;
      default: break;
    }
  };

  //=================================================
  // Render
  //=================================================

  if (fatal) {
    return (
      <div className="centred">
        <Icon name="warning" size={44} weight={1.3} style={{ color: 'var(--red)' }} />
        <h2 style={{ margin: 0, fontSize: 17 }}>Cannot reach the server</h2>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{fatal}</p>
        <button type="button" className="button" onClick={() => window.location.reload()}>Try again</button>
      </div>
    );
  }

  if (signedOut || expired) {
    return <SignIn expired={expired} onSignedIn={() => window.location.reload()} />;
  }

  if (!session) {
    return <div className="centred"><div className="spinner" /></div>;
  }

  const crumbs = breadcrumbs(listing?.entry.path ?? path, rootLabels);
  const currentRoot = path.split('/').filter(Boolean)[0] ?? null;

  return (
    <div
      className={`app${dragging ? ' dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => void onDrop(event)}
    >
      <Sidebar
        roots={session.roots}
        currentRoot={currentRoot}
        view={view}
        user={session.user}
        usage={session.usage}
        open={sidebarOpen}
        onNavigate={navigate}
        onShowTrash={() => {
          setView('trash');
          setSelection(new Set());
          setSidebarOpen(false);
        }}
        onShowUsers={() => {
          setUsersOpen(true);
          setSidebarOpen(false);
        }}
        onShowSettings={() => {
          setSettingsOpen(true);
          setSidebarOpen(false);
        }}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="main">
        <header className="toolbar">
          <button
            type="button"
            className="iconbutton toolbar__menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="Show locations"
          >
            <Icon name="list" size={18} />
          </button>

          <button
            type="button"
            className="iconbutton"
            onClick={() => navigate(parentOf(path))}
            disabled={view !== 'browse' || listing?.parent === null}
            aria-label="Go up one folder"
          >
            <Icon name="chevronLeft" size={18} weight={2} />
          </button>

          {view === 'browse' ? (
            <nav className="crumbs" aria-label="Breadcrumb">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} style={{ display: 'contents' }}>
                  {index > 0 && <Icon name="chevronRight" size={13} weight={2.2} className="crumbs__sep" />}
                  <button type="button" className="crumbs__item" onClick={() => navigate(crumb.path)}>
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
          ) : (
            <h1 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
              {view === 'trash' ? 'Recently Deleted' : `Results for “${query}”`}
            </h1>
          )}

          <div className="toolbar__spacer" />

          <label className="searchfield">
            <Icon name="search" size={15} />
            <input
              type="search"
              placeholder="Search"
              value={query}
              onChange={(event) => {
                const value = event.target.value;
                setQuery(value);
                setView(value.trim().length >= 2 ? 'search' : 'browse');
              }}
              aria-label="Search files"
            />
          </label>

          <div className="toolbar__group">
            <button
              type="button"
              className="iconbutton"
              aria-pressed={viewMode === 'list'}
              onClick={() => setViewMode('list')}
              aria-label="List view"
            >
              <Icon name="list" size={17} />
            </button>
            <button
              type="button"
              className="iconbutton"
              aria-pressed={viewMode === 'grid'}
              onClick={() => setViewMode('grid')}
              aria-label="Grid view"
            >
              <Icon name="grid" size={17} />
            </button>
          </div>

          {view === 'browse' && writable && (
            <div className="toolbar__group" style={{ gap: 6, marginLeft: 4 }}>
              <button
                type="button"
                className="iconbutton"
                onClick={() => setDialog({ kind: 'newFolder' })}
                aria-label="New folder"
                title="New folder"
              >
                <Icon name="folderPlus" size={18} />
              </button>
              <button type="button" className="button button--primary" onClick={() => filePicker.current?.click()}>
                <Icon name="upload" size={15} />
                Upload
              </button>
            </div>
          )}

          {view === 'trash' && (trash?.items.length ?? 0) > 0 && (
            <button
              type="button"
              className="button button--danger"
              onClick={() => setDialog({ kind: 'confirmEmptyTrash' })}
            >
              Empty
            </button>
          )}
        </header>

        <div
          className="content"
          onContextMenu={(event: MouseEvent) => {
            if (view !== 'browse' || !writable) return;
            event.preventDefault();
            setSelection(new Set());
            setMenu({ x: event.clientX, y: event.clientY, entry: null });
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelection(new Set());
          }}
        >
          {error && (
            <div className="banner" role="alert">
              <Icon name="warning" size={17} />
              <span style={{ flex: 1 }}>{error}</span>
              <button type="button" onClick={() => void refresh()}>Retry</button>
            </div>
          )}

          {notice && (
            <div className="banner banner--info" role="status">
              <Icon name="info" size={17} />
              <span style={{ flex: 1 }}>{notice}</span>
              <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
            </div>
          )}

          {loading ? (
            <div className="centred"><div className="spinner" /></div>
          ) : view === 'trash' ? (
            <TrashView
              items={trash?.items ?? []}
              retentionDays={trash?.retentionDays ?? 30}
              onRestore={(item) => void runAction(() => api.restoreFromTrash(item.id))}
              onPurge={(item) => setDialog({ kind: 'confirmPurge', item })}
            />
          ) : entries.length === 0 ? (
            <EmptyState
              view={view}
              query={query}
              shared={currentRoot === 'shared'}
              onUpload={() => filePicker.current?.click()}
            />
          ) : (
            <FileBrowser
              entries={entries}
              ticket={ticket}
              view={viewMode}
              sort={sort}
              descending={descending}
              selection={selection}
              showOwner={currentRoot === 'shared' || view === 'search'}
              onSelectionChange={setSelection}
              onOpen={open}
              onContextMenu={(entry, event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, entry });
              }}
              onSortChange={(key) => {
                if (key === sort) setDescending((value) => !value);
                else {
                  setSort(key);
                  // Newest-first and largest-first are what people mean when
                  // they sort by date or size; names read better A→Z.
                  setDescending(key === 'mtime' || key === 'size');
                }
              }}
            />
          )}
        </div>
      </main>

      {/* Hidden pickers, driven by the toolbar and the context menu. */}
      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          startUpload(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <input
        ref={folderPicker}
        type="file"
        hidden
        // @ts-expect-error — non-standard but supported everywhere it matters.
        webkitdirectory=""
        onChange={(event) => {
          startUpload(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />

      {/* Unsharing stays available inside Shared, where nothing else is. */}
      {view !== 'trash' && (
        <SelectionBar
          selected={selected}
          writable={writable && selected.every((entry) => !entry.readOnly && !entry.sharedBy)}
          onDownload={() => download(selected)}
          onShare={() => setDialog({ kind: 'share', entries: selected })}
          onUnshare={() => void doUnshare(selected)}
          onMove={() => setDialog({ kind: 'pick', operation: 'move', entries: selected })}
          onCopy={() => setDialog({ kind: 'pick', operation: 'copy', entries: selected })}
          onRename={() => selected[0] && setDialog({ kind: 'rename', entry: selected[0] })}
          onDelete={() => setDialog({ kind: 'confirmDelete', entries: selected })}
          onClear={() => setSelection(new Set())}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          actions={menuActions}
          onSelect={onMenuSelect}
          onDismiss={() => setMenu(null)}
        />
      )}

      {dialog?.kind === 'newFolder' && (
        <PromptDialog
          title="New Folder"
          message="Choose a name for the new folder."
          initialValue="Untitled Folder"
          confirmLabel="Create"
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null);
            void runAction(() => api.createFolder(`${path}/${name}`));
          }}
        />
      )}

      {dialog?.kind === 'rename' && (
        <PromptDialog
          title="Rename"
          initialValue={dialog.entry.name}
          selectLength={splitExtension(dialog.entry.name).base.length}
          confirmLabel="Rename"
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            const entry = dialog.entry;
            setDialog(null);
            void runAction(() => api.rename(entry.path, name));
          }}
        />
      )}

      {dialog?.kind === 'confirmDelete' && (
        <ConfirmDialog
          title={
            dialog.entries.length === 1
              ? `Delete “${dialog.entries[0]?.name}”?`
              : `Delete ${dialog.entries.length} items?`
          }
          message={
            `${dialog.entries.some((entry) => entry.shared) ? 'This is shared with everyone. ' : ''}` +
            'Deleted items go to Recently Deleted, where you can put them back for 30 days.'
          }
          confirmLabel="Delete"
          destructive
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const victims = dialog.entries;
            setDialog(null);
            void doDelete(victims);
          }}
        />
      )}

      {dialog?.kind === 'pick' && (
        <FolderPicker
          title={dialog.operation === 'move' ? 'Move to' : 'Copy to'}
          confirmLabel={dialog.operation === 'move' ? 'Move here' : 'Copy here'}
          // Neither a folder nor anything inside it can be its own destination.
          excluded={dialog.entries.filter((entry) => entry.isDir).map((entry) => entry.path)}
          onCancel={() => setDialog(null)}
          onConfirm={(destination) => {
            const { operation, entries: chosen } = dialog;
            setDialog(null);
            void doTransfer(operation, chosen, destination);
          }}
        />
      )}

      {dialog?.kind === 'share' && (
        <ShareDialog
          entries={dialog.entries}
          onCancel={() => setDialog(null)}
          onConfirm={(visibility, sharedWith) => {
            const entries = dialog.entries;
            setDialog(null);
            void doShare(entries, visibility, sharedWith);
          }}
        />
      )}

      {dialog?.kind === 'confirmPurge' && (
        <ConfirmDialog
          title={`Delete “${dialog.item.name}” permanently?`}
          message="This item will be removed immediately. You cannot undo this."
          confirmLabel="Delete"
          destructive
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const item = dialog.item;
            setDialog(null);
            void runAction(() => api.purgeFromTrash(item.id));
          }}
        />
      )}

      {dialog?.kind === 'confirmEmptyTrash' && (
        <ConfirmDialog
          title="Empty Recently Deleted?"
          message="Everything in Recently Deleted will be removed immediately. You cannot undo this."
          confirmLabel="Empty"
          destructive
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void runAction(() => api.emptyTrash());
          }}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          session={session}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => {
            void refresh();
            refreshUsage();
          }}
        />
      )}

      {usersOpen && (
        <UsersView
          session={session}
          onClose={() => setUsersOpen(false)}
        />
      )}

      {previewIndex !== null && ticket && previewable[previewIndex] && (
        <PreviewOverlay
          entries={previewable}
          index={previewIndex}
          ticket={ticket}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}

      <UploadTray
        onFinished={(parent) => {
          if (view === 'browse' && parent === path) void refresh();
          refreshUsage();
        }}
      />
    </div>
  );
}

function EmptyState({
  view, query, shared, onUpload,
}: {
  view: View;
  query: string;
  shared: boolean;
  onUpload: () => void;
}) {
  if (view === 'search') {
    return (
      <div className="empty">
        <Icon name="search" size={44} weight={1.2} />
        <h2>No results</h2>
        <p>Nothing matched “{query}”.</p>
      </div>
    );
  }

  if (shared) {
    return (
      <div className="empty">
        <Icon name="shared" size={48} weight={1.2} />
        <h2>Nothing is shared yet</h2>
        <p>
          Shared lists the items people have published. To put something here, select it in My Files
          and choose Share — it stays where it is, and everyone with access can read it.
        </p>
      </div>
    );
  }

  return (
    <div className="empty">
      <Icon name="folder" size={48} weight={1.2} />
      <h2>This folder is empty</h2>
      <p>Drag files here to upload them, or use the Upload button.</p>
      <button type="button" className="button" onClick={onUpload} style={{ marginTop: 4 }}>
        <Icon name="upload" size={15} />
        Upload Files
      </button>
    </div>
  );
}
