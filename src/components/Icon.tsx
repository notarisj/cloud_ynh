/**
 * The icon set, inlined.
 *
 * Drawn as stroked 24×24 paths in the SF Symbols idiom — consistent weight,
 * rounded caps, optically centred. Inlining them rather than pulling in an
 * icon package keeps the bundle small and means the strict Content Security
 * Policy never has to allow a second origin.
 */

export type IconName =
  | 'folder' | 'folderPlus' | 'file' | 'photo' | 'video' | 'music' | 'pdf' | 'code' | 'archive'
  | 'chevronRight' | 'chevronLeft' | 'chevronDown' | 'arrowUp'
  | 'grid' | 'list' | 'search' | 'upload' | 'download' | 'trash' | 'ellipsis'
  | 'pencil' | 'copy' | 'move' | 'close' | 'refresh' | 'cloud' | 'check'
  | 'sort' | 'restore' | 'info' | 'shared' | 'home' | 'warning';

const PATHS: Record<IconName, string> = {
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l.9 1.2h7.3A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z',
  folderPlus: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l.9 1.2h7.3A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5zM12 10.5v5M9.5 13h5',
  file: 'M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7zM14 3v4h4',
  photo: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM4 16l4.2-4a1.8 1.8 0 0 1 2.5 0L16 17M14.5 14l1.4-1.3a1.8 1.8 0 0 1 2.4 0L20 14M9.5 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0',
  video: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h8A2.5 2.5 0 0 1 16 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 3 16.5zM16 10.2l4-2.3v8.2l-4-2.3z',
  music: 'M9 18V6.2l10-2v11.3M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0M19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0',
  pdf: 'M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7zM14 3v4h4M8.5 17c2-1 3.2-3.2 3.8-5 .4-1.3.1-2.2-.6-2.2-.8 0-1 1-.5 2.5.8 2.4 2.3 3.9 3.8 4',
  code: 'M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7zM14 3v4h4M9.5 12.5 8 14l1.5 1.5M14.5 12.5 16 14l-1.5 1.5',
  archive: 'M3.5 7.5h17M4.5 7.5v10A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-10M6 7.5 7.3 4.6A1 1 0 0 1 8.2 4h7.6a1 1 0 0 1 .9.6L18 7.5M10 12h4',
  chevronRight: 'm9.5 6 6 6-6 6',
  chevronLeft: 'm14.5 6-6 6 6 6',
  chevronDown: 'm6 9.5 6 6 6-6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  grid: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h3A1.5 1.5 0 0 1 10 5.5v3A1.5 1.5 0 0 1 8.5 10h-3A1.5 1.5 0 0 1 4 8.5zM14 5.5A1.5 1.5 0 0 1 15.5 4h3A1.5 1.5 0 0 1 20 5.5v3A1.5 1.5 0 0 1 18.5 10h-3A1.5 1.5 0 0 1 14 8.5zM4 15.5A1.5 1.5 0 0 1 5.5 14h3A1.5 1.5 0 0 1 10 15.5v3A1.5 1.5 0 0 1 8.5 20h-3A1.5 1.5 0 0 1 4 18.5zM14 15.5A1.5 1.5 0 0 1 15.5 14h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5z',
  list: 'M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM20 20l-3.9-3.9',
  upload: 'M12 15.5V4M8 8l4-4 4 4M4.5 15v3A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-3',
  download: 'M12 4v11.5M8 11.5l4 4 4-4M4.5 15v3A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-3',
  trash: 'M4.5 6.5h15M9.5 6.5V5A1.5 1.5 0 0 1 11 3.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5l.8 12A2 2 0 0 0 9.3 20.5h5.4a2 2 0 0 0 2-1.9l.8-12.1M10.5 10.5v6M13.5 10.5v6',
  ellipsis: 'M6 12h.01M12 12h.01M18 12h.01',
  pencil: 'M4.5 19.5h3.4l9.3-9.3a2.4 2.4 0 0 0-3.4-3.4L4.5 16.1zM13.5 8l2.5 2.5',
  copy: 'M9 9.5A2.5 2.5 0 0 1 11.5 7h6A2.5 2.5 0 0 1 20 9.5v6a2.5 2.5 0 0 1-2.5 2.5h-6A2.5 2.5 0 0 1 9 15.5zM15 7V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H7',
  move: 'M12 4v16M4 12h16M12 4 9 7M12 4l3 3M12 20l-3-3M12 20l3-3M4 12l3-3M4 12l3 3M20 12l-3-3M20 12l-3 3',
  close: 'm6 6 12 12M18 6 6 18',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5',
  cloud: 'M7 18.5a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.4 10 3.75 3.75 0 0 1 17 18.5z',
  check: 'm5 12.5 4.5 4.5L19 7',
  sort: 'M7 4v14M7 18l-3-3M7 18l3-3M17 20V6M17 6l-3 3M17 6l3 3',
  restore: 'M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 7.75h.01',
  shared: 'M15.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.5 15.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.5 15.5c-2.8 0-5 1.7-5 3.8v1.2h10v-1.2c0-2.1-2.2-3.8-5-3.8M15.5 9.5c2.8 0 5 1.7 5 3.8v.7h-3.6',
  home: 'M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19zM9.5 20.5v-6h5v6',
  warning: 'M10.3 4.3 3 17a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0ZM12 9.5v4M12 16.75h.01',
};

interface IconProps {
  name: IconName;
  size?: number;
  /** Slightly heavier stroke reads better at small sizes in the sidebar. */
  weight?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 20, weight = 1.6, className, style }: IconProps) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Icon and tint for a file, chosen from its preview kind and extension. */
export function iconForEntry(entry: { isDir: boolean; name: string; preview: string | null }): {
  name: IconName;
  tint: string;
} {
  if (entry.isDir) return { name: 'folder', tint: 'var(--accent)' };

  switch (entry.preview) {
    case 'image':
      return { name: 'photo', tint: 'var(--purple)' };
    case 'video':
      return { name: 'video', tint: 'var(--red)' };
    case 'audio':
      return { name: 'music', tint: 'var(--orange)' };
    case 'pdf':
      return { name: 'pdf', tint: 'var(--red)' };
    case 'text':
      return { name: 'code', tint: 'var(--teal)' };
    default:
      break;
  }

  const extension = entry.name.split('.').pop()?.toLowerCase() ?? '';
  if (['zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso'].includes(extension)) {
    return { name: 'archive', tint: 'var(--gray)' };
  }
  return { name: 'file', tint: 'var(--gray)' };
}
