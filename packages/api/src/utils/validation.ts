import { AppError } from '../middleware/errorHandler';

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `${field} is required and must be a non-empty string`,
    );
  }
  return value.trim();
}

export function requirePositiveInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AppError(400, 'VALIDATION_ERROR', `${field} must be a positive integer`);
  }
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUUID(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', `${field} must be a valid UUID`);
  }
  return value;
}
