import {
  useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent,
} from 'react';
import * as api from './lib/api';
import { ApiError, SessionExpiredError } from './lib/api';
import type { FileEntry, Listing, Session, SortKey, TrashItem } from './lib/api';
import { breadcrumbs, splitExtension } from './lib/format';
import { loadPreferences, savePreferences } from './lib/prefs';
import { locationHash, readHash, type View } from './lib/routing';
import { filesFromDrop, uploads } from './lib/uploads';
import { ContextMenu, type MenuAction } from './components/ContextMenu';
import { Breadcrumbs } from './components/Breadcrumbs';
import { ConfirmDialog, PromptDialog } from './components/Dialogs';
import { FileBrowser, draggedPaths, type ViewMode } from './components/FileBrowser';
import { FolderPicker } from './components/FolderPicker';
import { InfoDialog } from './components/InfoDialog';
import { LinkDialog } from './components/LinkDialog';
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


/** Clipboard for cut/copy, held only for the lifetime of the page. */
interface Clipboard {
  paths: string[];
  operation: 'copy' | 'cut';
}

type Dialog =
  | { kind: 'newFolder' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'confirmDelete'; entries: FileEntry[] }
  | { kind: 'confirmPurge'; items: TrashItem[] }
  | { kind: 'confirmEmptyTrash' }
  | { kind: 'pick'; operation: 'move' | 'copy'; entries: FileEntry[] }
  | { kind: 'info'; entry: FileEntry }
  | { kind: 'link'; entry: FileEntry }
  | { kind: 'share'; entries: FileEntry[] }
  | null;

/** Renew a read ticket this long before it lapses. */
const TICKET_MARGIN_MS = 60_000;

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [signInReason, setSignInReason] = useState<string | null>(null);

  const initial = useMemo(() => readHash(), []);
  const [view, setView] = useState<View>(initial.view);
  const [path, setPath] = useState(initial.path);
  const [query, setQuery] = useState(initial.query);

  const [listing, setListing] = useState<Listing | null>(null);
  // Search results and Recents are both flat lists drawn from anywhere, with
  // one ticket covering every root.
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
          setSignInReason(cause.reason);
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
      setSignInReason(cause.reason);
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
      } else if (view === 'recents') {
        setSearchResults(await loadRecents(session));
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
    const hash = locationHash({ view, path, query });
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

  // Thumbnails, previews and download links carry a read ticket that lasts a
  // quarter of an hour. A page left open longer would quietly stop loading
  // images, so the ticket is renewed shortly before it runs out.
  const flat = view === 'search' || view === 'recents';
  const ticketScope = flat ? '/' : (listing?.entry.path ?? null);
  const ticketToken = flat ? searchResults?.ticket : listing?.ticket.token;
  const ticketLifetime = flat ? 15 * 60 : (listing?.ticket.expiresIn ?? 15 * 60);

  useEffect(() => {
    if (!ticketScope || !ticketToken) return;
    const delay = Math.max(ticketLifetime * 1000 - TICKET_MARGIN_MS, 30_000);
    const timer = window.setTimeout(() => {
      api
        .ticket(ticketScope)
        .then((fresh) => {
          if (ticketScope === '/') {
            setSearchResults((current) => (current ? { ...current, ticket: fresh.token } : current));
          } else {
            setListing((current) =>
              current && current.entry.path === ticketScope ? { ...current, ticket: fresh } : current,
            );
          }
        })
        .catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [ticketScope, ticketToken, ticketLifetime]);

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

  const entries = flat ? (searchResults?.results ?? []) : (listing?.entries ?? []);
  const ticket = flat ? (searchResults?.ticket || null) : (listing?.ticket.token ?? null);
  const previewable = useMemo(() => entries.filter((entry) => !entry.isDir), [entries]);

  // Shared is a view of what other people published, so nothing can be written
  // into it. The server is the authority; this is what the toolbar reads.
  const writable = view === 'browse' && (listing?.writable ?? path.startsWith('/me'));
  // An admin can turn sharing off; then there is no Shared root to offer.
  const sharingEnabled = session?.roots.some((root) => root.id === 'shared') ?? false;
  const linksEnabled = session?.limits.publicLinks === true;

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

  const doDuplicate = (targets: FileEntry[]) =>
    runAction(async () => {
      for (const target of targets) await api.duplicate(target.path);
    });

  /** Drag and drop onto a folder: move what was dragged into it. */
  const moveInto = (paths: string[], destination: string) =>
    runAction(async () => {
      let moved = 0;
      for (const source of paths) {
        const name = source.split('/').pop() ?? '';
        const parent = source.split('/').slice(0, -1).join('/');
        // Dropping something where it already is, or a folder into itself.
        if (parent === destination || destination === source || destination.startsWith(`${source}/`)) continue;
        await api.move(source, `${destination}/${name}`, 'rename');
        moved += 1;
      }
      setSelection(new Set());
      if (moved > 0) {
        setNotice(`${moved === 1 ? '1 item' : `${moved} items`} moved to ${destination === '/me' ? 'My Files' : destination.split('/').pop()}.`);
      }
    });

  const doShare = (targets: FileEntry[], visibility: 'all' | 'users' = 'all', sharedWith: string[] = []) =>
    runAction(async () => {
      for (const target of targets) await api.share(target.path, visibility, sharedWith);
      const audience =
        visibility === 'users'
          ? ` for ${sharedWith.length === 1 ? '1 person' : `${sharedWith.length} people`}`
          : '';
      setNotice(
        targets.length === 1
          ? `“${targets[0]?.name}” is now in Shared${audience}. It stays in My Files.`
          : `${targets.length} items are now in Shared${audience}. They stay in My Files.`,
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
      if (!ticket || targets.length === 0) return;
      // One file downloads as itself. A folder, or several items, comes down
      // as a single ZIP — one save dialog rather than a burst of them, and
      // the only way a folder can be downloaded at all.
      const only = targets.length === 1 ? targets[0] : undefined;
      const href = only && !only.isDir
        ? api.downloadUrl(ticket, only.path)
        : api.archiveUrl(ticket, targets.map((entry) => entry.path), listing?.entry.name);
      const link = document.createElement('a');
      link.href = href;
      if (only && !only.isDir) link.download = only.name;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    },
    [ticket, listing],
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
    if (view === 'trash' || draggedPaths(event)) return;
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
      if (dialog || previewIndex !== null || settingsOpen || usersOpen) return;

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
      if (meta && event.key.toLowerCase() === 'i' && selected.length === 1 && selected[0]) {
        event.preventDefault();
        setDialog({ kind: 'info', entry: selected[0] });
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
  }, [dialog, previewIndex, settingsOpen, usersOpen, entries, selected, writable, doPaste, open]);

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
      { id: 'info', label: 'Get Info', icon: 'info', disabled: many },
      {
        id: 'download',
        label: many || entry.isDir ? 'Download as ZIP' : 'Download',
        icon: 'download',
      },
    ];

    if (entry.shared && !entry.readOnly) {
      // Who it reaches is changed from the item's own place in My Files.
      const adjustable = mine && sharingEnabled && entry.path.startsWith('/me/') && !many;
      if (adjustable) actions.push({ id: 'share', label: 'Sharing Options…', icon: 'shared', separatorBefore: true });
      actions.push({ id: 'unshare', label: 'Stop Sharing', icon: 'shared', separatorBefore: !adjustable });
    } else if (mine && sharingEnabled) {
      actions.push({ id: 'share', label: 'Share…', icon: 'shared', separatorBefore: true });
    }
    // A public link reaches people with no account here, so it is only ever
    // made from the item's own place in My Files.
    if (linksEnabled && entry.path.startsWith('/me/') && !many) {
      actions.push({ id: 'link', label: 'Public Link…', icon: 'link', separatorBefore: !(mine && sharingEnabled) && !entry.shared });
    }

    actions.push(
      { id: 'copyTo', label: 'Copy to…', icon: 'copy', separatorBefore: true },
    );

    if (writable && mine) {
      actions.push(
        { id: 'moveTo', label: 'Move to…', icon: 'move' },
        { id: 'rename', label: 'Rename…', icon: 'pencil', disabled: many },
        { id: 'duplicate', label: 'Duplicate', icon: 'copy' },
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
  }, [menu, selected, clipboard, writable, sharingEnabled, linksEnabled]);

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
      case 'info': if (entry) setDialog({ kind: 'info', entry }); break;
      case 'link': if (entry) setDialog({ kind: 'link', entry }); break;
      case 'duplicate': void doDuplicate(targets()); break;
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
    return (
      <SignIn
        expired={expired}
        portalDisabled={api.portalSignInDisabled()}
        reason={signInReason}
        onSignedIn={() => window.location.reload()}
      />
    );
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
        onDropInto={(paths, folder) => void moveInto(paths, folder)}
        onShowRecents={() => {
          setView('recents');
          setQuery('');
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

      {/* Narrow screens slide the sidebar over the content; a tap beside it
          closes it, the way a sheet is dismissed. */}
      {sidebarOpen && <div className="sidebar__scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}

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
            <Breadcrumbs
              crumbs={crumbs}
              onNavigate={navigate}
              onDropInto={writable ? (paths, folder) => void moveInto(paths, folder) : undefined}
            />
          ) : (
            <h1 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
              {view === 'trash' ? 'Recently Deleted' : view === 'recents' ? 'Recents' : `Results for “${query}”`}
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

          {/* Recently Deleted is a list and nothing else. */}
          {view !== 'trash' && (
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
          )}

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
              <button
                type="button"
                className="button button--primary"
                onClick={() => filePicker.current?.click()}
                aria-label="Upload files"
              >
                <Icon name="upload" size={15} />
                <span className="button__label">Upload</span>
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
              onRestore={(items) =>
                void runAction(async () => {
                  for (const item of items) await api.restoreFromTrash(item.id);
                })
              }
              onPurge={(items) => setDialog({ kind: 'confirmPurge', items })}
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
              showOwner={currentRoot === 'shared' || flat}
              onSelectionChange={setSelection}
              onOpen={open}
              onContextMenu={(entry, event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, entry });
              }}
              // Only your own items move, and only out of a folder you may change.
              canDrag={(entry) => writable && !entry.readOnly && !entry.sharedBy}
              onDropInto={(paths, folder) => void moveInto(paths, folder)}
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
          sharingEnabled={sharingEnabled}
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

      {dialog?.kind === 'info' && (
        <InfoDialog entry={dialog.entry} ticket={ticket} rootLabels={rootLabels} onClose={() => setDialog(null)} />
      )}

      {dialog?.kind === 'link' && <LinkDialog entry={dialog.entry} onClose={() => setDialog(null)} />}

      {dialog?.kind === 'share' && (
        <ShareDialog
          entries={dialog.entries}
          me={session.user.username}
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
          title={
            dialog.items.length === 1
              ? `Delete “${dialog.items[0]?.name}” permanently?`
              : `Delete ${dialog.items.length} items permanently?`
          }
          message="They will be removed immediately. You cannot undo this."
          confirmLabel="Delete"
          destructive
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const doomed = dialog.items;
            setDialog(null);
            void runAction(async () => {
              for (const item of doomed) await api.purgeFromTrash(item.id);
            });
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

/** How far back Recents reaches, and how much of it is shown — the same as iOS. */
const RECENTS_WINDOW_MS = 30 * 86_400_000;
const RECENTS_LIMIT = 100;

/**
 * What changed lately, newest first, wherever it lives. Every root is asked,
 * because something shared with you is as recent as anything of your own.
 */
async function loadRecents(session: Session): Promise<{ results: FileEntry[]; ticket: string }> {
  const since = Date.now() - RECENTS_WINDOW_MS;
  const [lists, ticket] = await Promise.all([
    Promise.all(session.roots.map((root) => api.recentChanges(root.path, since, RECENTS_LIMIT * 2).catch(() => []))),
    api.ticket('/'),
  ]);

  const newest = new Map<string, FileEntry>();
  for (const entry of lists.flat()) if (!entry.isDir) newest.set(entry.path, entry);
  const results = [...newest.values()].sort((a, b) => b.mtime - a.mtime).slice(0, RECENTS_LIMIT);
  return { results, ticket: ticket.token };
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

  if (view === 'recents') {
    return (
      <div className="empty">
        <Icon name="clock" size={48} weight={1.2} />
        <h2>No recent files</h2>
        <p>Files you add or change show up here.</p>
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
