import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 does not forward rejected promises to the error handler, so every
 * async route is wrapped. Without this a thrown HttpError becomes a hung
 * request instead of a JSON error.
 */
export function wrap(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
