import { useEffect, useRef, useState } from 'react';
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
 *
 * The stage is a flex row with a definite height, which is what makes
 * `max-height: 100%` on the media mean anything: in a grid whose rows size
 * themselves to their content, the same declaration resolves against nothing
 * and a tall photo is simply cut off at the bottom of the window.
 */
export function PreviewOverlay({ entries, index, ticket, onIndexChange, onClose }: PreviewOverlayProps) {
  const entry = entries[index];
  const [zoomed, setZoomed] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // A new file is always shown fitted, whatever the last one was set to.
  useEffect(() => setZoomed(false), [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1);
      if (event.key === 'ArrowRight' && index < entries.length - 1) onIndexChange(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, entries.length, onIndexChange, onClose]);

  // The page behind must not scroll while the overlay is up — on a phone that
  // is the difference between swiping a photo and scrolling the folder.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!entry) return null;

  const isImage = entry.preview === 'image';

  /** Horizontal swipes step through the folder; vertical ones are scrolling. */
  const onTouchEnd = (event: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || zoomed) return;

    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

    if (dx > 0 && index > 0) onIndexChange(index - 1);
    if (dx < 0 && index < entries.length - 1) onIndexChange(index + 1);
  };

  return (
    <div className="preview" role="dialog" aria-modal="true" aria-label={entry.name}>
      <header className="preview__bar">
        <button type="button" className="iconbutton" onClick={onClose} aria-label="Close preview">
          <Icon name="close" size={19} />
        </button>

        <div className="preview__title">
          {entry.name}
          {entries.length > 1 && (
            <span className="preview__counter">
              {index + 1} of {entries.length}
            </span>
          )}
        </div>

        {isImage && (
          <button
            type="button"
            className="iconbutton"
            onClick={() => setZoomed((value) => !value)}
            aria-pressed={zoomed}
            aria-label={zoomed ? 'Fit to window' : 'Zoom to full size'}
            title={zoomed ? 'Fit to window' : 'Zoom to full size'}
          >
            <Icon name={zoomed ? 'grid' : 'search'} size={18} />
          </button>
        )}

        <a
          className="iconbutton"
          href={downloadUrl(ticket, entry.path)}
          download={entry.name}
          aria-label={`Download ${entry.name}`}
        >
          <Icon name="download" size={19} />
        </a>
      </header>

      <div
        className={`preview__stage${zoomed ? ' preview__stage--zoomed' : ''}`}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
        }}
        onTouchEnd={onTouchEnd}
        // Clicking the backdrop closes, the way a lightbox should; clicking the
        // picture itself does not.
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
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

        <PreviewBody entry={entry} ticket={ticket} zoomed={zoomed} onToggleZoom={() => setZoomed((v) => !v)} />

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

function PreviewBody({
  entry, ticket, zoomed, onToggleZoom,
}: {
  entry: FileEntry;
  ticket: string;
  zoomed: boolean;
  onToggleZoom: () => void;
}) {
  const source = previewUrl(ticket, entry.path);

  switch (entry.preview) {
    case 'image':
      return (
        <img
          src={source}
          alt={entry.name}
          className={zoomed ? 'preview__media preview__media--zoomed' : 'preview__media'}
          onClick={onToggleZoom}
        />
      );
    case 'video':
      // eslint-disable-next-line jsx-a11y/media-has-caption
      return <video src={source} className="preview__media" controls autoPlay playsInline />;
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
