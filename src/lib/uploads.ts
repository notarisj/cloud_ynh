import * as api from './api';
import type { ConflictPolicy, FileEntry } from './api';

/**
 * The upload queue.
 *
 * Files are sent through the resumable API: one session per file, chunks
 * pushed a few at a time. That is more machinery than a single POST, but it is
 * what makes a dropped Wi-Fi connection recoverable instead of fatal, and it
 * gives honest per-file progress rather than a bar that jumps to 100% while
 * the browser is still flushing its buffer.
 */

export type UploadState = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';

export interface UploadTask {
  id: string;
  file: File;
  /** Virtual path of the destination, including the filename. */
  target: string;
  /** Folder the task belongs to, so the listing can refresh itself. */
  parent: string;
  state: UploadState;
  /** Bytes confirmed written by the server. */
  sent: number;
  total: number;
  error?: string;
  entry?: FileEntry;
}

type Listener = (tasks: UploadTask[]) => void;

/** Two files at a time; more mostly fights for the same uplink. */
const MAX_PARALLEL_FILES = 2;
/** Chunks in flight per file. Keeps a fast link busy without buffering the world. */
const MAX_PARALLEL_CHUNKS = 3;

class UploadManager {
  private tasks: UploadTask[] = [];
  private listeners = new Set<Listener>();
  private controllers = new Map<string, AbortController>();
  private active = 0;
  private pumping = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private snapshot(): UploadTask[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private update(id: string, patch: Partial<UploadTask>): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    Object.assign(task, patch);
    this.emit();
  }

  /** Queue files for a folder. Returns the ids so a caller can watch them. */
  enqueue(files: File[], parent: string, conflict: ConflictPolicy = 'rename'): string[] {
    const ids: string[] = [];

    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      // webkitRelativePath is set when a whole folder was dropped or picked;
      // it carries the subfolder structure the user expects to be preserved.
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const suffix = relative && relative.length > 0 ? relative : file.name;

      this.tasks.push({
        id,
        file,
        target: `${parent.replace(/\/+$/, '')}/${suffix}`,
        parent,
        state: 'queued',
        sent: 0,
        total: file.size,
      });
      ids.push(id);
      this.conflictPolicies.set(id, conflict);
    }

    this.emit();
    void this.pump();
    return ids;
  }

  private conflictPolicies = new Map<string, ConflictPolicy>();

  cancel(id: string): void {
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.update(id, { state: 'cancelled' });
  }

  retry(id: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || (task.state !== 'failed' && task.state !== 'cancelled')) return;
    this.update(id, { state: 'queued', sent: 0, error: undefined });
    void this.pump();
  }

  /** Drop finished and cancelled entries from the tray. */
  clearFinished(): void {
    this.tasks = this.tasks.filter((t) => t.state === 'queued' || t.state === 'uploading');
    this.emit();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;

    try {
      while (this.active < MAX_PARALLEL_FILES) {
        const next = this.tasks.find((t) => t.state === 'queued');
        if (!next) break;

        this.active += 1;
        this.update(next.id, { state: 'uploading' });

        void this.run(next.id).finally(() => {
          this.active -= 1;
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(id: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;

    const controller = new AbortController();
    this.controllers.set(id, controller);

    let sessionId: string | null = null;

    try {
      const session = await api.beginUpload(
        task.target,
        task.file.size,
        task.file.lastModified,
        this.conflictPolicies.get(id) ?? 'rename',
      );
      sessionId = session.id;

      // A zero-byte file has no chunks; the session is completed straight away.
      if (session.chunkCount > 0) {
        await this.sendChunks(id, session, task.file, controller.signal);
      }

      const entry = await api.completeUpload(session.id);
      this.update(id, { state: 'done', sent: task.file.size, entry });
    } catch (error) {
      if (controller.signal.aborted) {
        if (sessionId) void api.abortUpload(sessionId);
        this.update(id, { state: 'cancelled' });
        return;
      }
      const message = error instanceof Error ? error.message : 'Upload failed';
      // The session is left on the server: a retry resumes it rather than
      // starting over, which is the whole point of the chunked API.
      this.update(id, { state: 'failed', error: message });
    } finally {
      this.controllers.delete(id);
    }
  }

  private async sendChunks(
    id: string,
    session: api.UploadSession,
    file: File,
    signal: AbortSignal,
  ): Promise<void> {
    const pending = [...session.missing];
    let confirmed = session.received.length * session.chunkSize;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const index = pending.shift();
        if (index === undefined) return;

        const start = index * session.chunkSize;
        const end = Math.min(start + session.chunkSize, file.size);
        const blob = file.slice(start, end);

        // One retry per chunk absorbs the transient failures — a dropped
        // connection on a train, a proxy hiccup — without a user-visible error.
        try {
          await api.putChunk(session.id, index, blob, signal);
        } catch (error) {
          if (signal.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, 1200));
          if (signal.aborted) return;
          await api.putChunk(session.id, index, blob, signal);
        }

        confirmed += end - start;
        this.update(id, { sent: Math.min(confirmed, file.size) });
      }
    };

    const workers = Array.from(
      { length: Math.min(MAX_PARALLEL_CHUNKS, pending.length) },
      () => worker(),
    );
    await Promise.all(workers);
  }
}

export const uploads = new UploadManager();

/** Read a DataTransfer, walking directory entries so dropped folders work. */
export async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);

  // Not every browser exposes the entry API; fall back to the flat file list.
  if (entries.length === 0) return Array.from(dataTransfer.files ?? []);

  const files: File[] = [];

  const readEntry = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => {
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
      });
      if (!file) return;
      // Re-create the File so the relative path survives; webkitRelativePath
      // is read-only and empty on entries obtained this way.
      Object.defineProperty(file, 'webkitRelativePath', {
        value: prefix ? `${prefix}/${file.name}` : file.name,
        configurable: true,
      });
      files.push(file);
      return;
    }

    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const nested = prefix ? `${prefix}/${entry.name}` : entry.name;

      // readEntries returns at most 100 at a time and signals the end with an
      // empty batch, so it has to be drained in a loop.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) => {
          reader.readEntries(resolve, () => resolve([]));
        });
        if (batch.length === 0) break;
        for (const child of batch) await readEntry(child, nested);
      }
    }
  };

  for (const entry of entries) await readEntry(entry, '');
  return files;
}
