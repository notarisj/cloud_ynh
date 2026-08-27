import type { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError } from '../lib/errors';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}`, code: 'no_route' });
};

/**
 * Anything that is not an HttpError is a bug: the client gets a bare 500 while
 * the real cause goes to the journal, where `yunohost app log` can find it.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) {
    // The response is already streaming — the only useful thing left is to cut
    // it off so the client sees a truncated body rather than a valid short one.
    res.destroy();
    return;
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) console.error(`[cloud] ${req.method} ${req.path}:`, err);
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }

  // express.json() rejects malformed bodies with a SyntaxError carrying a status.
  const status = (err as { status?: number })?.status;
  if (status === 400 && err instanceof SyntaxError) {
    res.status(400).json({ error: 'Malformed JSON body', code: 'bad_json' });
    return;
  }

  console.error(`[cloud] unhandled error on ${req.method} ${req.path}:`, err);
  res.status(500).json({ error: 'Internal server error', code: 'internal' });
};
