/**
 * The base class for every failure this API reports on purpose.
 *
 * The split that matters: an `AppError` is a situation we predicted (slot taken, token expired,
 * doctor not found). Anything else that reaches the error handler is a bug, and the two get very
 * different treatment — predicted failures show their message to the user, bugs never do.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: readonly { path: string; message: string }[];

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options?: { cause?: unknown; details?: readonly { path: string; message: string }[] },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    if (options?.details) {
      this.details = options.details;
    }
  }
}

export class BadRequestError extends AppError {
  constructor(
    message: string,
    options?: { cause?: unknown; details?: readonly { path: string; message: string }[] },
  ) {
    super(400, 'BAD_REQUEST', message, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource does not exist.', options?: { cause?: unknown }) {
    super(404, 'NOT_FOUND', message, options);
  }
}

/** No credentials, or credentials that do not check out. The caller needs to (re-)authenticate. */
export class UnauthorizedError extends AppError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(401, code, message, options);
  }
}

/** Authenticated, but not allowed to do this. Logging in again would not help. */
export class ForbiddenError extends AppError {
  constructor(message = 'You are not allowed to do that.', options?: { cause?: unknown }) {
    super(403, 'FORBIDDEN', message, options);
  }
}

/** The request is fine on its own, but it collides with the current state of something. */
export class ConflictError extends AppError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(409, code, message, options);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(503, 'SERVICE_UNAVAILABLE', message, options);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Pulls a readable line out of something that was thrown. JavaScript lets code throw anything at
 * all — a string, a number, `undefined` — so this never assumes it was handed an Error.
 *
 * The awkward case worth knowing about: when Node dials a hostname that resolves to both an IPv6
 * and an IPv4 address it tries both at once, and a failure comes back as an AggregateError whose
 * own message is an empty string. Reading only `.message` there produces a blank error, which is
 * the least helpful thing a log can say. The real reasons live in `.errors`.
 */
export function describeUnknownError(value: unknown): string {
  if (value instanceof AggregateError && value.errors.length > 0) {
    const reasons = value.errors.map(describeUnknownError);
    return [...new Set(reasons)].join('; ');
  }

  if (value instanceof Error) {
    if (value.message.length > 0) {
      return value.message;
    }
    // An Error with no message still knows its own name, and Node attaches a `code` such as
    // ECONNREFUSED. Either is far better than returning nothing.
    const code = readErrorCode(value);
    return code ? `${value.name} (${code})` : value.name;
  }

  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return 'Unknown error';
}

function readErrorCode(error: Error): string | undefined {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}
