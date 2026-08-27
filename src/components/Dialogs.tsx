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
  useEffect(() => confirmButton.current?.focus(), []);

  return (
    <Scrim onDismiss={onCancel}>
      <div className="dialog" role="alertdialog" aria-modal="true">
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="dialog__actions">
          <button type="button" className="button" onClick={onCancel}>Cancel</button>
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

function Scrim({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      className="scrim"
      // Only a click on the backdrop itself dismisses; one that started inside
      // the dialog and drifted out should not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      {children}
    </div>
  );
}
