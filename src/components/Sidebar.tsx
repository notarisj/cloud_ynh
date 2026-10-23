import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { formatBytes } from '../lib/format';
import type { RootInfo, Usage } from '../lib/api';
import type { View } from '../lib/routing';

interface SidebarProps {
  roots: RootInfo[];
  currentRoot: string | null;
  view: View;
  user: { displayName: string; username: string };
  usage: Usage | null;
  open: boolean;
  onNavigate: (path: string) => void;
  onShowTrash: () => void;
  onShowRecents: () => void;
  onShowSettings: () => void;
  onClose: () => void;
}

const ROOT_ICONS: Record<string, 'home' | 'shared'> = { me: 'home', shared: 'shared' };

export function Sidebar({
  roots, currentRoot, view, user, usage, open, onNavigate, onShowTrash, onShowRecents, onShowSettings, onClose,
}: SidebarProps) {
  // An unlimited quota has no meaningful bar, so the meter falls back to the
  // volume's free space — still useful, and honest about what it is showing.
  const metered = usage !== null && usage.quotaBytes > 0;
  const fraction = metered ? Math.min(1, usage.usedBytes / usage.quotaBytes) : 0;
  const level = fraction > 0.95 ? 'full' : fraction > 0.8 ? 'warn' : 'ok';


  return (
    <nav className="sidebar" data-open={open} aria-label="Locations">
      <div className="sidebar__brand">
        <Icon name="cloud" size={22} weight={1.7} />
        <strong>Cloud</strong>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="iconbutton sidebar__close"
          onClick={onClose}
          aria-label="Close sidebar"
        >
          <Icon name="close" size={18} />
        </button>
      </div>

      <button
        type="button"
        className="sidebar__item"
        aria-current={view === 'recents'}
        onClick={onShowRecents}
      >
        <Icon name="clock" size={18} />
        <span>Recents</span>
      </button>

      <div className="sidebar__section">Locations</div>

      {roots.map((root) => (
        <button
          key={root.id}
          type="button"
          className="sidebar__item"
          aria-current={view === 'browse' && currentRoot === root.id}
          onClick={() => onNavigate(root.path)}
          title={
            root.id === 'shared'
              ? 'Items people have published. Everything you own stays in My Files.'
              : undefined
          }
        >
          <Icon name={ROOT_ICONS[root.id] ?? 'folder'} size={18} />
          <span>{root.name}</span>
        </button>
      ))}

      <button
        type="button"
        className="sidebar__item"
        aria-current={view === 'trash'}
        onClick={onShowTrash}
      >
        <Icon name="trash" size={18} />
        <span>Recently Deleted</span>
      </button>

      <div className="sidebar__spacer" />

      <div className="storage">
        <div className="storage__label">
          <span>{usage ? formatBytes(usage.usedBytes) : '—'} used</span>
          <span>
            {metered
              ? `of ${formatBytes(usage.quotaBytes)}`
              : usage
                ? `${formatBytes(usage.availableBytes)} free`
                : ''}
          </span>
        </div>
        {metered && (
          <div className="storage__track">
            <div
              className="storage__fill"
              data-level={level}
              style={{ width: `${Math.max(fraction * 100, 2)}%` }}
            />
          </div>
        )}

        <button type="button" className="storage__user" onClick={onShowSettings} title="Settings">
          <Avatar name={user.displayName || user.username} />
          <span>{user.displayName || user.username}</span>
          <Icon name="info" size={16} />
        </button>
      </div>
    </nav>
  );
}
