import { useCallback, useEffect, useState } from 'react';
import { PromptDialog, Scrim } from './Dialogs';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { formatBytes, formatDate } from '../lib/format';
import * as api from '../lib/api';
import type { DeviceSession, LinkSummary, PasskeySummary, Session, ShareSummary } from '../lib/api';

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
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [links, setLinks] = useState<LinkSummary[] | null>(null);
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(false);
  const [renaming, setRenaming] = useState<PasskeySummary | null>(null);

  const passkeysEnabled = session.limits.passkeys !== false;
  const sharingEnabled = session.roots.some((root) => root.id === 'shared');
  const linksEnabled = session.limits.publicLinks === true;

  const refresh = useCallback(async () => {
    setError(null);
    const noKeys = { passkeys: [] as PasskeySummary[], ssoDisabled: false };
    const [keys, devices, published, linked] = await Promise.all([
      passkeysEnabled ? api.listPasskeys().catch(() => noKeys) : Promise.resolve(noKeys),
      api.listSessions().catch(() => ({ sessions: [] as DeviceSession[] })),
      sharingEnabled
        ? api.listShares().catch(() => ({ shares: [] as ShareSummary[], enabled: true }))
        : Promise.resolve({ shares: [] as ShareSummary[], enabled: false }),
      linksEnabled
        ? api.listLinks().catch(() => ({ links: [] as LinkSummary[], enabled: true }))
        : Promise.resolve({ links: [] as LinkSummary[], enabled: false }),
    ]);
    setPasskeys(keys.passkeys);
    setSsoDisabled(keys.ssoDisabled === true);
    setShares(published.shares);
    setLinks(linked.links);
    setSessions(devices.sessions);
  }, [passkeysEnabled, sharingEnabled, linksEnabled]);

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
              <Avatar name={session.user.displayName || session.user.username} size={36} />
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

              {/* Shown once there is a passkey to fall back on, and always while
                  the portal is off, so it can be turned back on from here. */}
              {passkeys && (passkeys.length > 0 || ssoDisabled) && (
                <div className="sheet__subsection">
                  <h4>Portal sign-in</h4>
                  <p className="sheet__lede">
                    {ssoDisabled
                      ? 'The YunoHost portal no longer signs you in to this app in a browser — only your passkeys do. Removing your last passkey turns the portal back on.'
                      : 'Require a passkey to open this app in a browser, even when you are already signed in to the YunoHost portal. The iOS app keeps using your password.'}
                  </p>
                  <button
                    type="button"
                    className={`button${ssoDisabled ? '' : ' button--danger'}`}
                    onClick={() => run(() => api.setSsoDisabled(!ssoDisabled))}
                    disabled={busy}
                  >
                    {!ssoDisabled && <Icon name="warning" size={15} />}
                    {ssoDisabled ? 'Allow portal sign-in again' : 'Passkeys only'}
                  </button>
                </div>
              )}
            </section>
          )}


          {sharingEnabled && (
            <section className="sheet__section">
              <h3>Shared by you</h3>
              <p className="sheet__lede">
                Everyone with access to this app can open these. Stopping sharing deletes nothing — the item
                stays in My Files.
              </p>
              {shares === null ? (
                <div className="spinner" />
              ) : shares.length === 0 ? (
                <p className="sheet__empty">You have not shared anything.</p>
              ) : (
                shares.map((item) => (
                  <div key={item.id} className="sheet__row">
                    <Icon name={item.isDir === false ? 'file' : 'folder'} size={18} style={{ color: 'var(--accent)' }} />
                    <div className="sheet__rowtext">
                      <strong>{item.name}</strong>
                      <span>
                        {displayPath(item.path)} · shared {formatDate(item.sharedAt)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="button"
                      onClick={() => run(() => api.unshareById(item.id))}
                      disabled={busy}
                    >
                      Stop sharing
                    </button>
                  </div>
                ))
              )}
            </section>
          )}

          {linksEnabled && (
            <section className="sheet__section">
              <h3>Public links</h3>
              <p className="sheet__lede">
                Anyone with one of these links can download the item — no account needed. Removing a link
                stops it working; the item itself is untouched.
              </p>
              {links === null ? (
                <div className="spinner" />
              ) : links.length === 0 ? (
                <p className="sheet__empty">You have no public links.</p>
              ) : (
                links.map((link) => (
                  <div key={link.id} className="sheet__row">
                    <Icon name="link" size={18} style={{ color: 'var(--accent)' }} />
                    <div className="sheet__rowtext">
                      <strong>{link.name}</strong>
                      <span>
                        {displayPath(link.path)} ·{' '}
                        {link.expiresAt ? `expires ${formatDate(link.expiresAt)}` : 'does not expire'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="iconbutton"
                      title="Copy link"
                      aria-label={`Copy link to ${link.name}`}
                      onClick={() => void navigator.clipboard?.writeText(link.url)}
                    >
                      <Icon name="copy" size={15} />
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => run(() => api.removeLink(link.id))}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </section>
          )}

          <section className="sheet__section">
            <h3>Signed-in devices</h3>
            {sessions === null ? (
              <div className="spinner" />
            ) : sessions.length === 0 ? (
              <p className="sheet__empty">
                No devices are signed in. Browsers that came in through the portal are not listed — signing
                out of the portal ends them.
              </p>
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

/** "/me/Photos/Trip" as "My Files › Photos › Trip". */
function displayPath(vpath: string): string {
  const [, ...rest] = vpath.split('/').filter(Boolean);
  return ['My Files', ...rest].join(' › ');
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
