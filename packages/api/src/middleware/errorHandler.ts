import type { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const requestId = res.locals['requestId'] as string | undefined;
  const isProd = process.env['NODE_ENV'] === 'production';

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
      request_id: requestId,
    });
    return;
  }

  // Unexpected error — log internally, never leak internals in production
  console.error({ requestId, err }, 'Unhandled error');

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProd ? 'An unexpected error occurred.' : String(err),
    },
    request_id: requestId,
  });
}
