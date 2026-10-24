import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Scrim } from './Dialogs';
import { Icon } from './Icon';
import * as api from '../lib/api';

/**
 * Signing this browser in from a phone that is already signed in.
 *
 * The browser asks the server for a request and shows it as a QR code, with
 * a number beside it. The Cloud app on the phone scans the code, shows which
 * browser is asking, and asks for that number; once it is picked, this
 * browser — polling with a secret only it holds — is handed a session of its
 * own. See server/src/services/quickSignIn.ts for the reasoning.
 */
export function QuickSignInDialog({ onSignedIn, onClose }: { onSignedIn: () => void; onClose: () => void }) {
  const [start, setStart] = useState<api.QuickStart | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<api.QuickStatus>('pending');
  const [error, setError] = useState<string | null>(null);
  // A new code each time the last one ends, so the dialog never strands you.
  const [round, setRound] = useState(0);
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('pending');
    setError(null);
    setStart(null);
    setSvg(null);

    void api
      .startQuickSignIn()
      .then(async (started) => {
        if (cancelled) return;
        setStart(started);
        setSvg(await QRCode.toString(started.url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }));
      })
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : 'Could not start.'));

    return () => {
      cancelled = true;
    };
  }, [round]);

  // Ask the server, once a second, how it is going.
  useEffect(() => {
    if (!start) return;
    let cancelled = false;

    const tick = async () => {
      while (!cancelled && !closed.current) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (cancelled) return;
        try {
          const result = await api.pollQuickSignIn(start);
          if (cancelled) return;
          setStatus(result.status);
          if (result.status === 'approved' && result.session) {
            onSignedIn();
            return;
          }
          if (result.status === 'denied' || result.status === 'expired') return;
        } catch (cause) {
          if (!cancelled) setError(cause instanceof Error ? cause.message : 'Lost touch with the server.');
          return;
        }
      }
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [start, onSignedIn]);

  const ended = status === 'denied' || status === 'expired';

  return (
    <Scrim onDismiss={onClose}>
      <div className="dialog dialog--quick" role="dialog" aria-modal="true" aria-labelledby="quick-title">
        <h2 id="quick-title">Sign In with Your iPhone</h2>
        <p>
          In the Cloud app, open <strong>Settings</strong> and choose <strong>Sign In a Browser</strong>,
          then scan this code.
        </p>

        <div className="quick__code" aria-hidden={ended}>
          {svg && !ended ? (
            <div className="quick__qr" dangerouslySetInnerHTML={{ __html: svg }} />
          ) : (
            <div className="quick__qr quick__qr--empty">
              {error || ended ? <Icon name="warning" size={28} /> : <div className="spinner" />}
            </div>
          )}
        </div>

        {start && !ended && (
          <div className="quick__match">
            <span>When your iPhone asks, choose</span>
            <strong aria-live="polite">{start.code}</strong>
          </div>
        )}

        <p className="quick__status" role="status">
          {error
            ? error
            : status === 'scanned'
              ? 'Scanned. Confirm on your iPhone.'
              : status === 'denied'
                ? 'Not approved. If that was a mistake, try again.'
                : status === 'expired'
                  ? 'This code has expired.'
                  : 'Waiting for your iPhone…'}
        </p>

        <div className="dialog__actions">
          {(ended || error) && (
            <button type="button" className="button" onClick={() => setRound((r) => r + 1)}>
              New Code
            </button>
          )}
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Scrim>
  );
}

/**
 * The page a QR code opens when it is scanned with the camera instead of the
 * Cloud app: there is nothing to do in a browser, so say what to do instead.
 */
export function QuickSignInHelp() {
  return (
    <div className="signin">
      <div className="signin__card">
        <Icon name="cloud" size={44} weight={1.5} style={{ color: 'var(--accent)' }} />
        <h1>Open the Cloud App</h1>
        <p>
          This code signs a browser in from the Cloud app. In the app, open Settings, choose
          <strong> Sign In a Browser</strong>, and scan the code again.
        </p>
      </div>
    </div>
  );
}
