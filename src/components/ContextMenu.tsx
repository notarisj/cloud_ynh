import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';

export interface MenuAction {
  id: string;
  label: string;
  icon: IconName;
  danger?: boolean;
  separatorBefore?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  actions: MenuAction[];
  onSelect: (id: string) => void;
  onDismiss: () => void;
}

export function ContextMenu({ x, y, actions, onSelect, onDismiss }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Flip the menu back inside the viewport when it was opened near an edge —
  // measured after mount, because the height depends on the action list.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.min(x, window.innerWidth - width - 8),
      top: Math.min(y, window.innerHeight - height - 8),
    });
  }, [x, y]);

  // Read through a ref so the listeners below are added once, not again on
  // every render of the caller — a re-subscription mid-event drops it.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const onDismiss = () => dismissRef.current();
    // Anywhere *except* the menu itself. Dismissing on every pointerdown —
    // even one that landed on a menu item — unmounts the menu before the click
    // that follows can reach it, which quietly turns every action in here into
    // a no-op: the menu closes, and nothing happens.
    const dismiss = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onDismiss();
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };

    // `capture` so a click outside closes the menu before that click lands.
    // A resize moves everything under the menu, so it stops making sense
    // wherever it is — that one closes unconditionally.
    const close = () => onDismiss();

    window.addEventListener('pointerdown', dismiss, { capture: true });
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', dismiss, { capture: true });
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={position}
    >
      {actions.map((action) => (
        <div key={action.id}>
          {action.separatorBefore && <div className="menu__separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`menu__item${action.danger ? ' menu__item--danger' : ''}`}
            disabled={action.disabled}
            onClick={() => {
              onSelect(action.id);
              onDismiss();
            }}
          >
            <Icon name={action.icon} size={16} />
            {action.label}
          </button>
        </div>
      ))}
    </div>
  );
}
