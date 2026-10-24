import { useLayoutEffect, useRef, useState } from 'react';
import { ContextMenu, type MenuAction } from './ContextMenu';
import { DRAG_TYPE, draggedPaths } from './FileBrowser';
import { Icon } from './Icon';

export interface Crumb {
  label: string;
  path: string;
}

interface BreadcrumbsProps {
  crumbs: Crumb[];
  onNavigate: (path: string) => void;
  /**
   * Items dragged from the list were dropped on a crumb. A folder further up
   * the path is a place to drop things, the way the Finder's path bar is; the
   * last crumb is where they already are, so it never takes a drop.
   */
  onDropInto?: (paths: string[], folder: string) => void;
}

/**
 * How many crumbs stay on screen before the middle is folded away.
 *
 * Four is the smallest number that still answers the two questions a path bar
 * is for — "which root am I in" and "where exactly am I" — while leaving one
 * step of context in between. Everything else goes behind the ellipsis, which
 * is a better place for it than a row of six-character stubs that all read
 * "Untitl".
 */
const VISIBLE = 4;

export function Breadcrumbs({ crumbs, onNavigate, onDropInto }: BreadcrumbsProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const ellipsis = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLElement>(null);

  // On a narrow window even the folded path can be wider than the bar, and a
  // list that overflows scrolls off to the right — which hides the one crumb
  // that matters most, the folder you are actually in. Pin the view to the end
  // instead, so the path trails off behind you rather than in front.
  useLayoutEffect(() => {
    const element = bar.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [crumbs]);

  // Deep path: root, an ellipsis standing for everything skipped, then the
  // last two — the folder you are in and the one it sits in.
  const collapsed = crumbs.length > VISIBLE;
  const hidden = collapsed ? crumbs.slice(1, crumbs.length - 2) : [];
  const shown = collapsed
    ? [crumbs[0]!, ...crumbs.slice(crumbs.length - 2)]
    : crumbs;

  const hiddenActions: MenuAction[] = hidden.map((crumb) => ({
    id: crumb.path,
    label: crumb.label,
    icon: 'folder',
  }));

  return (
    <nav ref={bar} className="crumbs" aria-label="Breadcrumb">
      {shown.map((crumb, index) => {
        // The ellipsis belongs after the root, which is the one place a folder
        // was actually left out.
        const foldHere = collapsed && index === 1;

        return (
          <span key={crumb.path} className="crumbs__step">
            {index > 0 && <Icon name="chevronRight" size={13} weight={2.2} className="crumbs__sep" />}

            {foldHere && (
              <>
                <button
                  ref={ellipsis}
                  type="button"
                  className="crumbs__item crumbs__more"
                  aria-label={`Show the ${hidden.length} folders in between`}
                  title={hidden.map((entry) => entry.label).join(' / ')}
                  onClick={() => {
                    const box = ellipsis.current?.getBoundingClientRect();
                    if (box) setMenu({ x: box.left, y: box.bottom + 4 });
                  }}
                >
                  <Icon name="ellipsis" size={15} weight={2.4} />
                </button>
                <Icon name="chevronRight" size={13} weight={2.2} className="crumbs__sep" />
              </>
            )}

            <button
              type="button"
              className="crumbs__item"
              title={crumb.label}
              onClick={() => onNavigate(crumb.path)}
              onDragOver={(event) => {
                if (onDropInto && index < shown.length - 1 && event.dataTransfer.types.includes(DRAG_TYPE)) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                const paths = draggedPaths(event);
                if (!paths || !onDropInto || index === shown.length - 1) return;
                event.preventDefault();
                event.stopPropagation();
                onDropInto(paths, crumb.path);
              }}
            >
              {crumb.label}
            </button>
          </span>
        );
      })}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          actions={hiddenActions}
          onSelect={onNavigate}
          onDismiss={() => setMenu(null)}
        />
      )}
    </nav>
  );
}
