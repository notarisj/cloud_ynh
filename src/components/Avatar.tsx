import { initials } from '../lib/format';

/**
 * A monogram in a filled circle — the Contacts treatment, and the same one
 * the iOS app draws, so a person's mark looks the same everywhere.
 */
export function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <div
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initials(name)}
    </div>
  );
}
