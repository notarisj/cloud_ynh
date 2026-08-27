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

  useEffect(() => {
    const dismiss = () => onDismiss();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };

    // `capture` so a click anywhere closes the menu before the click lands.
    window.addEventListener('pointerdown', dismiss, { capture: true });
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', dismiss, { capture: true });
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
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
