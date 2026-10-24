import { useEffect, useRef, useState, type FormEvent } from 'react';

interface PromptDialogProps {
  title: string;
  message?: string;
  initialValue: string;
  confirmLabel: string;
  /** Characters of the initial value to preselect — used to skip a file extension. */
  selectLength?: number;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({
  title, message, initialValue, confirmLabel, selectLength, onConfirm, onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus();
    // Renaming "photo.jpg" should preselect "photo", the way the Finder does,
    // so typing replaces the name and keeps the extension.
    element.setSelectionRange(0, selectLength ?? initialValue.length);
  }, [initialValue, selectLength]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length > 0) onConfirm(trimmed);
  };

  return (
    <Scrim onDismiss={onCancel}>
      <form className="dialog" onSubmit={submit}>
        <h2>{title}</h2>
        {message && <p>{message}</p>}
        <input
          ref={input}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="dialog__actions">
          <button type="button" className="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="button button--primary" disabled={value.trim().length === 0}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Scrim>
  );
}

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title, message, confirmLabel, destructive, onConfirm, onCancel,
}: ConfirmDialogProps) {
  const confirmButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  // A destructive action is never the default: Return should not delete
  // anything, so focus starts on Cancel there, as in every Apple alert.
  useEffect(() => (destructive ? cancelButton : confirmButton).current?.focus(), [destructive]);

  return (
    <Scrim onDismiss={onCancel}>
      <div className="dialog" role="alertdialog" aria-modal="true">
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="dialog__actions">
          <button ref={cancelButton} type="button" className="button" onClick={onCancel}>Cancel</button>
          <button
            ref={confirmButton}
            type="button"
            className={`button ${destructive ? 'button--danger' : 'button--primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Scrim>
  );
}

/** Open modals, innermost last: Escape belongs to the one on top. */
const stack: symbol[] = [];

/**
 * The backdrop every modal shares.
 *
 * Exported because "Escape closes this" and "a click outside closes this" are
 * not decorations — a panel that ignores Escape is a panel the keyboard cannot
 * get out of — and each modal reimplementing them is how one of them ends up
 * without.
 */
export function Scrim({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  const [id] = useState(() => Symbol('scrim'));
  // Callers pass a fresh closure on every render. Reading it through a ref
  // keeps one listener for the modal's whole life: re-subscribing on each
  // render would drop a key press whenever another listener re-renders the
  // app before this one runs.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    stack.push(id);
    const onKey = (event: KeyboardEvent) => {
      // A confirmation over a sheet closes on its own; the sheet stays.
      if (event.key !== 'Escape' || stack[stack.length - 1] !== id) return;
      // Closing this one can unmount it before the next listener runs, which
      // would make the modal underneath "the top" for the same key press.
      event.stopImmediatePropagation();
      dismiss.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const index = stack.lastIndexOf(id);
      if (index !== -1) stack.splice(index, 1);
    };
  }, [id]);

  return (
    <div
      className="scrim"
      // Only a click on the backdrop itself dismisses; one that started inside
      // the dialog and drifted out should not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss.current();
      }}
    >
      {children}
    </div>
  );
}
