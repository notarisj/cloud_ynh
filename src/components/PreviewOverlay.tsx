import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { downloadUrl, fetchText, previewUrl } from '../lib/api';
import type { FileEntry } from '../lib/api';

interface PreviewOverlayProps {
  /** Everything in the folder, so the arrow keys can step through it. */
  entries: FileEntry[];
  index: number;
  ticket: string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/**
 * Full-screen preview.
 *
 * Images, video, audio and PDFs are streamed straight from the preview
 * endpoint, which serves them with `Content-Security-Policy: sandbox` so a
 * crafted PDF or SVG cannot reach back into the app's origin. Text is fetched
 * and rendered as text rather than handed to the browser to interpret, for
 * the same reason.
 */
export function PreviewOverlay({ entries, index, ticket, onIndexChange, onClose }: PreviewOverlayProps) {
  const entry = entries[index];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1);
      if (event.key === 'ArrowRight' && index < entries.length - 1) onIndexChange(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, entries.length, onIndexChange, onClose]);

  if (!entry) return null;

  return (
    <div className="preview" role="dialog" aria-modal="true" aria-label={entry.name}>
      <header className="preview__bar">
        <button type="button" className="iconbutton" onClick={onClose} aria-label="Close preview">
          <Icon name="close" size={19} />
        </button>
        <div className="preview__title">{entry.name}</div>
        <a
          className="iconbutton"
          href={downloadUrl(ticket, entry.path)}
          download={entry.name}
          aria-label={`Download ${entry.name}`}
        >
          <Icon name="download" size={19} />
        </a>
      </header>

      <div className="preview__stage">
        {index > 0 && (
          <button
            type="button"
            className="preview__nav preview__nav--prev"
            onClick={() => onIndexChange(index - 1)}
            aria-label="Previous"
          >
            <Icon name="chevronLeft" size={20} weight={2} />
          </button>
        )}

        <PreviewBody entry={entry} ticket={ticket} />

        {index < entries.length - 1 && (
          <button
            type="button"
            className="preview__nav preview__nav--next"
            onClick={() => onIndexChange(index + 1)}
            aria-label="Next"
          >
            <Icon name="chevronRight" size={20} weight={2} />
          </button>
        )}
      </div>
    </div>
  );
}

function PreviewBody({ entry, ticket }: { entry: FileEntry; ticket: string }) {
  const source = previewUrl(ticket, entry.path);

  switch (entry.preview) {
    case 'image':
      return <img src={source} alt={entry.name} />;
    case 'video':
      // eslint-disable-next-line jsx-a11y/media-has-caption
      return <video src={source} controls autoPlay playsInline />;
    case 'audio':
      return (
        <div className="preview__unsupported">
          <Icon name="music" size={64} weight={1.2} />
          <div style={{ fontSize: 14 }}>{entry.name}</div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio src={source} controls autoPlay style={{ width: 'min(420px, 80vw)' }} />
        </div>
      );
    case 'pdf':
      return <iframe src={source} title={entry.name} sandbox="" />;
    case 'text':
      return <TextPreview entry={entry} />;
    default:
      return (
        <div className="preview__unsupported">
          <Icon name="file" size={64} weight={1.2} />
          <p style={{ margin: 0 }}>There is no preview for this kind of file.</p>
          <a className="button button--primary" href={downloadUrl(ticket, entry.path)} download={entry.name}>
            <Icon name="download" size={16} />
            Download
          </a>
        </div>
      );
  }
}

/** Text files are fetched with the access token and shown as escaped text. */
function TextPreview({ entry }: { entry: FileEntry }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);

    fetchText(entry.path)
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not read this file.');
      });

    return () => {
      cancelled = true;
    };
  }, [entry.path]);

  if (error) return <div className="preview__unsupported"><Icon name="warning" size={40} />{error}</div>;
  if (text === null) return <div className="spinner" />;
  return <pre className="preview__text">{text}</pre>;
}
