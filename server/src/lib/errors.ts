/**
 * An error carrying the status code and machine-readable code that should be
 * sent to the client. Anything thrown that is not an HttpError is treated as a
 * bug and reported as a bare 500, with the detail kept in the journal.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest  = (msg: string, code = 'bad_request')  => new HttpError(400, code, msg);
export const unauthorized = (msg = 'Authentication required', code = 'unauthorized') =>
  new HttpError(401, code, msg);
export const forbidden   = (msg: string, code = 'forbidden')    => new HttpError(403, code, msg);
export const notFound    = (msg = 'Not found', code = 'not_found') => new HttpError(404, code, msg);
export const conflict    = (msg: string, code = 'conflict')     => new HttpError(409, code, msg);
export const tooLarge    = (msg: string, code = 'too_large')    => new HttpError(413, code, msg);
export const insufficientStorage = (msg: string) => new HttpError(507, 'quota_exceeded', msg);

/** Translate the errno codes the fs module throws into the right HTTP status. */
export function fromNodeError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ENOENT':      return notFound();
    case 'EEXIST':      return conflict('A file or folder with that name already exists', 'exists');
    case 'ENOTEMPTY':   return conflict('The folder is not empty', 'not_empty');
    case 'EACCES':
    case 'EPERM':       return forbidden('Permission denied on the underlying filesystem');
    case 'ENOSPC':      return insufficientStorage('The server has run out of disk space');
    case 'EISDIR':      return badRequest('That path is a folder', 'is_directory');
    case 'ENOTDIR':     return badRequest('That path is not a folder', 'not_directory');
    default:            return new HttpError(500, 'internal', 'Internal server error');
  }
}
