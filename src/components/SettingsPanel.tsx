import { useCallback, useEffect, useState } from 'react';
import { PromptDialog, Scrim } from './Dialogs';
import { Icon } from './Icon';
import { formatBytes, formatDate } from '../lib/format';
import * as api from '../lib/api';
import type { DeviceSession, PasskeySummary, Session } from '../lib/api';

interface SettingsPanelProps {
  session: Session;
  onClose: () => void;
  /** Called after anything that changes what the file views should show. */
  onChanged: () => void;
}

/**
 * Account settings.
 *
 * Three things a person actually needs to be able to see and undo: which keys
 * can open this account, which devices are still signed in, and what they have
 * published to everyone else. Each one is listed with a way to revoke it,
 * because a list you cannot act on is just an anxiety.
 */
export function SettingsPanel({ session, onClose, onChanged }: SettingsPanelProps) {
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [ssoDisabled, setSsoDisabled] = useState(false);
  const [storeFile, setStoreFile] = useState('');
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(false);
  const [renaming, setRenaming] = useState<PasskeySummary | null>(null);

  const passkeysEnabled = session.limits.passkeys !== false;

  const refresh = useCallback(async () => {
    setError(null);
    const [keys, devices] = await Promise.all([
      passkeysEnabled ? api.listPasskeys().catch(() => ({ passkeys: [], ssoDisabled: false, storeFile: '' })) : Promise.resolve({ passkeys: [], ssoDisabled: false, storeFile: '' }),
      api.listSessions().catch(() => ({ sessions: [] })),
    ]);
    setPasskeys(keys.passkeys);
    setSsoDisabled(keys.ssoDisabled || false);
    setStoreFile(keys.storeFile || '');
    setSessions(devices.sessions);
  }, [passkeysEnabled]);

  useEffect(() => {
    void refresh();
    void api.passkeysUsable().then(setSupported);
  }, [refresh]);

  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    work()
      .then(() => refresh())
      .then(() => onChanged())
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'AbortError')) {
          return;
        }
        setError(cause instanceof Error ? cause.message : 'That did not work.');
      })
      .finally(() => setBusy(false));
  };

  const addPasskey = () => {
    const suggested = defaultPasskeyName();
    run(() => api.registerPasskey(suggested));
  };

  return (
    <Scrim onDismiss={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="sheet__head">
          <h2>Settings</h2>
          <button type="button" className="iconbutton" onClick={onClose} aria-label="Close settings">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="sheet__body">
          {error && (
            <div className="banner" role="alert">
              <Icon name="warning" size={16} />
              <span style={{ flex: 1 }}>{error}</span>
            </div>
          )}

          <section className="sheet__section">
            <h3>Account</h3>
            <div className="sheet__row">
              <div className="storage__avatar" aria-hidden="true">
                {(session.user.displayName || session.user.username).slice(0, 2).toUpperCase()}
              </div>
              <div className="sheet__rowtext">
                <strong>{session.user.displayName || session.user.username}</strong>
                <span>
                  {session.user.email ?? session.user.username} · signed in with{' '}
                  {session.via === 'passkey' ? 'a passkey' : 'the portal'}
                </span>
              </div>
              {session.via === 'passkey' && (
                <button
                  type="button"
                  className="button"
                  onClick={() => void api.signOut().then(() => window.location.reload())}
                >
                  Sign out
                </button>
              )}
            </div>
            <div className="sheet__row">
              <Icon name="cloud" size={18} style={{ color: 'var(--accent)' }} />
              <div className="sheet__rowtext">
                <strong>{formatBytes(session.usage.usedBytes)} used</strong>
                <span>
                  {session.usage.quotaBytes > 0
                    ? `of ${formatBytes(session.usage.quotaBytes)} allowed`
                    : `${formatBytes(session.usage.availableBytes)} free on the server`}
                </span>
              </div>
            </div>
          </section>

          {passkeysEnabled && (
            <section className="sheet__section">
              <h3>Passkeys</h3>
              <p className="sheet__lede">
                A passkey signs you in with the fingerprint, face or PIN on one of your devices. The
                key itself never leaves that device, and there is no password to be phished or
                reused.
              </p>

              {passkeys === null ? (
                <div className="spinner" />
              ) : passkeys.length === 0 ? (
                <p className="sheet__empty">No passkeys yet.</p>
              ) : (
                passkeys.map((passkey) => (
                  <div key={passkey.id} className="sheet__row">
                    <Icon name="check" size={18} weight={2} style={{ color: 'var(--green)' }} />
                    <div className="sheet__rowtext">
                      <strong>{passkey.name}</strong>
                      <span>
                        Added {formatDate(passkey.createdAt)}
                        {passkey.synced ? ' · synced across your devices' : ' · this device only'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="iconbutton"
                      aria-label={`Rename ${passkey.name}`}
                      title="Rename"
                      onClick={() => setRenaming(passkey)}
                    >
                      <Icon name="pencil" size={15} />
                    </button>
                    <button
                      type="button"
                      className="iconbutton"
                      aria-label={`Remove ${passkey.name}`}
                      title="Remove"
                      onClick={() => run(() => api.removePasskey(passkey.id))}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                ))
              )}

              <button
                type="button"
                className="button button--primary"
                onClick={addPasskey}
                disabled={busy || !supported}
                title={supported ? undefined : 'This browser cannot create passkeys'}
              >
                <Icon name="check" size={15} weight={2.2} />
                Add a passkey
              </button>

              {passkeys && passkeys.length > 0 && (
                <div style={{ marginTop: '24px' }}>
                  <h4 style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: 600 }}>Disable SSOwat Login</h4>
                  {ssoDisabled ? (
                    <>
                      <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        SSOwat login is currently disabled. To re-enable it via SSH:
                      </p>
                      <code style={{ display: 'block', padding: '8px', background: 'var(--bg-field)', borderRadius: '4px', fontSize: '12px', wordBreak: 'break-all', userSelect: 'all', border: '1px solid var(--separator)' }}>
                        sudo jq '.ssoDisabled = false' {storeFile} &gt; /tmp/pk.json &amp;&amp; sudo mv /tmp/pk.json {storeFile} &amp;&amp; sudo systemctl restart cloud
                      </code>
                    </>
                  ) : (
                    <>
                      <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        You can disable standard YunoHost SSO login for this app and only allow passkeys.
                      </p>
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={() => run(() => api.setSsoDisabled(true))}
                        disabled={busy}
                      >
                        <Icon name="warning" size={15} />
                        Disable SSO login
                      </button>
                    </>
                  )}
                </div>
              )}
            </section>
          )}



          <section className="sheet__section">
            <h3>Signed-in devices</h3>
            {sessions === null ? (
              <div className="spinner" />
            ) : sessions.length === 0 ? (
              <p className="sheet__empty">No other devices are signed in.</p>
            ) : (
              sessions.map((device) => (
                <div key={device.id} className="sheet__row">
                  <Icon name="info" size={18} style={{ color: 'var(--text-tertiary)' }} />
                  <div className="sheet__rowtext">
                    <strong>
                      {device.device}
                      {device.current && <span className="pill">This device</span>}
                    </strong>
                    <span>Last used {formatDate(device.lastUsedAt)}</span>
                  </div>
                  <button
                    type="button"
                    className="iconbutton"
                    aria-label={`Sign out ${device.device}`}
                    title="Sign this device out"
                    onClick={() => run(() => api.revokeSession(device.id))}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              ))
            )}

            {(sessions?.length ?? 0) > 0 && (
              <button
                type="button"
                className="button button--danger"
                onClick={() => run(() => api.revokeAllSessions())}
              >
                Sign out everywhere
              </button>
            )}
          </section>
        </div>
      </div>

      {renaming && (
        <PromptDialog
          title="Name this passkey"
          message="Something you will recognise in this list — the device it lives on, usually."
          initialValue={renaming.name}
          confirmLabel="Save"
          onCancel={() => setRenaming(null)}
          onConfirm={(name) => {
            const passkey = renaming;
            setRenaming(null);
            run(() => api.renamePasskey(passkey.id, name));
          }}
        />
      )}
    </Scrim>
  );
}

/** A name the user will recognise in the list, without asking them for one. */
function defaultPasskeyName(): string {
  const agent = navigator.userAgent;
  if (/iPhone|iPad/.test(agent)) return 'iPhone or iPad';
  if (/Macintosh/.test(agent)) return 'Mac';
  if (/Android/.test(agent)) return 'Android device';
  if (/Windows/.test(agent)) return 'Windows device';
  return 'This device';
}
