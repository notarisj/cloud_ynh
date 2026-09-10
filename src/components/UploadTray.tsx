import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { formatBytes, formatRate, formatRemaining } from '../lib/format';
import { uploads, type UploadTask } from '../lib/uploads';

/**
 * The upload tray. Appears when something is queued and stays until dismissed,
 * so a completed batch can be reviewed rather than vanishing.
 */
/** Long enough to read "Uploaded", short enough not to sit there in the way. */
const DISMISS_AFTER_MS = 4000;

export function UploadTray({ onFinished }: { onFinished: (parent: string) => void }) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => uploads.subscribe(setTasks), []);

  // Refresh the listing each time a file lands, so the folder fills in as the
  // batch progresses instead of all at once at the end.
  useEffect(() => {
    const finished = tasks.filter((task) => task.state === 'done');
    if (finished.length === 0) return;
    const parents = new Set(finished.map((task) => task.parent));
    for (const parent of parents) onFinished(parent);
    // `tasks` identity changes on every progress tick; keying the effect on the
    // completed count keeps this to one refresh per completion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.filter((task) => task.state === 'done').length]);

  // Once every file has landed, the tray has said what it came to say. It
  // clears itself — but only on a clean sweep: anything that failed or was
  // cancelled stays, because that is exactly what somebody needs to see and
  // retry. Pointing at it holds it open, so it cannot vanish mid-read.
  const everythingLanded = tasks.length > 0 && tasks.every((task) => task.state === 'done');

  useEffect(() => {
    if (!everythingLanded || hovered) return;
    const timer = window.setTimeout(() => uploads.clearFinished(), DISMISS_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [everythingLanded, hovered]);

  if (tasks.length === 0) return null;

  const active = tasks.filter((task) => task.state === 'queued' || task.state === 'uploading');
  const failed = tasks.filter((task) => task.state === 'failed');
  const sent = tasks.reduce((total, task) => total + task.sent, 0);
  const size = tasks.reduce((total, task) => total + task.total, 0);

  // Everything still in flight, taken together: two files uploading at once
  // share one uplink, so their rates add up to what the connection is doing.
  const speed = active.reduce((total, task) => total + task.speed, 0);
  const remaining = speed > 0 ? formatRemaining((size - sent) / speed) : '';

  const heading =
    active.length > 0
      ? `Uploading ${active.length} item${active.length === 1 ? '' : 's'}`
      : failed.length > 0
        ? `${failed.length} upload${failed.length === 1 ? '' : 's'} failed`
        : `Uploaded ${tasks.length} item${tasks.length === 1 ? '' : 's'}`;

  return (
    <section
      className="tray"
      aria-label="Uploads"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <header className="tray__head">
        <span>
          {heading}
          {remaining && <span className="tray__eta">{remaining}</span>}
        </span>
        {active.length > 0 && (
          <span className="tray__totals">
            {formatBytes(sent)} / {formatBytes(size)}
            {speed > 0 && ` · ${formatRate(speed)}`}
          </span>
        )}
        <button
          type="button"
          className="iconbutton"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          aria-expanded={!collapsed}
        >
          <Icon name="chevronDown" size={16} style={collapsed ? { transform: 'rotate(180deg)' } : undefined} />
        </button>
        <button
          type="button"
          className="iconbutton"
          onClick={() => uploads.clearFinished()}
          aria-label="Dismiss finished uploads"
          disabled={active.length === tasks.length}
        >
          <Icon name="close" size={16} />
        </button>
      </header>

      {!collapsed && (
        <div className="tray__body">
          {tasks.map((task) => (
            <TrayRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </section>
  );
}

function TrayRow({ task }: { task: UploadTask }) {
  const percent = task.total > 0 ? Math.round((task.sent / task.total) * 100) : 100;

  return (
    <div className="tray__item">
      <div className="tray__name" title={task.file.name}>{task.file.name}</div>

      {task.state === 'uploading' || task.state === 'queued' ? (
        <button
          type="button"
          className="iconbutton"
          onClick={() => uploads.cancel(task.id)}
          aria-label={`Cancel upload of ${task.file.name}`}
        >
          <Icon name="close" size={15} />
        </button>
      ) : task.state === 'failed' || task.state === 'cancelled' ? (
        <button
          type="button"
          className="iconbutton"
          onClick={() => uploads.retry(task.id)}
          aria-label={`Retry upload of ${task.file.name}`}
        >
          <Icon name="refresh" size={15} />
        </button>
      ) : (
        <span style={{ color: 'var(--green)', display: 'grid', placeItems: 'center', width: 30 }}>
          <Icon name="check" size={15} weight={2.2} />
        </span>
      )}

      {(task.state === 'uploading' || task.state === 'queued') && (
        <div className="tray__track">
          <div className="tray__fill" style={{ width: `${percent}%` }} />
        </div>
      )}

      <div
        className={`tray__status${
          task.state === 'failed' ? ' tray__status--error' : task.state === 'done' ? ' tray__status--done' : ''
        }`}
      >
        {task.state === 'queued' && 'Waiting…'}
        {task.state === 'uploading' && (
          <>
            {`${percent}% · ${formatBytes(task.sent)} of ${formatBytes(task.total)}`}
            {task.speed > 0 && ` · ${formatRate(task.speed)}`}
            {task.speed > 0 && ` · ${formatRemaining((task.total - task.sent) / task.speed)}`}
          </>
        )}
        {task.state === 'done' && `Uploaded · ${formatBytes(task.total)}`}
        {task.state === 'cancelled' && 'Cancelled — tap to resume'}
        {task.state === 'failed' && (task.error ?? 'Failed')}
      </div>
    </div>
  );
}
