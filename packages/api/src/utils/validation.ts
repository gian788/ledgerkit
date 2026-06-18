import { AppError } from '../middleware/errorHandler.js';

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
