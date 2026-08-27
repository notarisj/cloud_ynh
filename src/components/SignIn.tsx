import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import * as api from '../lib/api';
import { portalUrl } from '../lib/api';

interface SignInProps {
  /** Shown when a session ended rather than never having existed. */
  expired: boolean;
  onSignedIn: () => void;
}

/**
 * The sign-in screen.
 *
 * Two doors, and they are not equivalent. The YunoHost portal is the shared
 * front door for the whole server — one password, every app. A passkey is
 * specific to this app and to this device: the private key is held by the
 * authenticator, nothing reusable crosses the network, and there is no
 * password for a look-alike page to collect.
 *
 * Nothing here asks for a username. Sign-in uses discoverable credentials, so
 * the browser offers whichever passkeys it holds for this site — which also
 * means this screen cannot be used to find out whether an account exists.
 */
export function SignIn({ expired, onSignedIn }: SignInProps) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.passkeysUsable().then((usable) => {
      if (!cancelled) setSupported(usable);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = () => {
    setBusy(true);
    setError(null);

    api
      .signInWithPasskey()
      .then(onSignedIn)
      .catch((cause: unknown) => {
        // A cancelled prompt is a decision, not a failure: the user closed the
        // sheet, and telling them "NotAllowedError" would be noise.
        if (cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'AbortError')) {
          return;
        }
        setError(cause instanceof Error ? cause.message : 'That passkey did not work.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="signin">
      <div className="signin__card">
        <Icon name="cloud" size={44} weight={1.5} style={{ color: 'var(--accent)' }} />
        <h1>Cloud</h1>
        <p>{expired ? 'Your session has expired.' : 'Sign in to reach your files.'}</p>

        {error && (
          <div className="banner" role="alert" style={{ margin: '4px 0 0' }}>
            <Icon name="warning" size={16} />
            <span style={{ flex: 1 }}>{error}</span>
          </div>
        )}

        {supported && (
          <button type="button" className="button button--primary signin__button" onClick={signIn} disabled={busy}>
            {busy ? <span className="spinner spinner--light" /> : <Icon name="check" size={16} weight={2.2} />}
            {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
          </button>
        )}

        <a className={`button signin__button${supported ? '' : ' button--primary'}`} href={portalUrl}>
          <Icon name="home" size={16} />
          Sign in with the portal
        </a>

        <p className="signin__hint">
          {supported === false
            ? 'This browser cannot use passkeys, so the portal is the way in.'
            : 'A passkey signs you in with the fingerprint, face or PIN you already use on this device. You can add one from Settings once you are in.'}
        </p>

        {/* Someone can land here because the API was restarting when the page
            loaded, not because their session ended. Retrying is then the whole
            fix, and it should not require knowing to press reload. */}
        <button type="button" className="signin__retry" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    </div>
  );
}
