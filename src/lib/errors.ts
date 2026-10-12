/** A user-facing error: `message` explains what happened and what to do next. */
export class AppError extends Error {
  code: string;
  detail: Record<string, unknown> | null;
  retryable: boolean;
  constructor(code: string, message: string, opts: { detail?: Record<string, unknown> | null; retryable?: boolean } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = opts.detail ?? null;
    this.retryable = opts.retryable ?? false;
  }
}

const FRIENDLY: Record<string, string> = {
  NOT_AUTHENTICATED: 'Your session has ended. Please sign in again.',
  FORBIDDEN: 'Your role in this business does not allow this. Ask the shop owner.',
  INVALID_INPUT: 'Some details are not right. Please check and try again.',
  PRODUCT_NOT_FOUND: 'That product could not be found. It may have been removed.',
  INSUFFICIENT_STOCK: 'There is not enough stock for this sale.',
  CUSTOMER_REQUIRED: 'Choose the customer who owes the unpaid balance.',
  CUSTOMER_NOT_FOUND: 'That customer could not be found.',
  DUPLICATE_NAME: 'You already have a product with that name.',
  SALE_NOT_FOUND: 'That sale could not be found.',
  SALE_ALREADY_REVERSED: 'This sale has already been reversed.',
  PAYMENT_EXCEEDS_BALANCE: 'That payment is more than the customer owes.',
  USER_NOT_FOUND: 'No Vendora account uses that email. Ask them to sign up first.',
  ALREADY_MEMBER: 'This person is already on your team.',
  LIMIT_REACHED: 'You have reached the limit for this action.',
  VENDOR_NOT_FOUND: 'That vendor is not available right now.',
  BLOCKED: 'You cannot contact this vendor.',
  MESSAGES_DISABLED: 'This vendor is not accepting messages.',
  ALREADY_PENDING: 'Your verification request is already being reviewed.',
  NETWORK: 'No internet connection. Check your data or Wi-Fi and try again.',
  NOT_CONFIGURED: 'Vendora is not connected to its database yet. Use the demo shop, or ask the admin to finish setup.',
};

interface PgLikeError {
  message?: string;
  details?: string | null;
  hint?: string | null;
  code?: string;
  status?: number;
}

function parseDetail(details: string | null | undefined): Record<string, unknown> | null {
  if (!details) return null;
  try {
    const v = JSON.parse(details);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function isNetworkError(e: unknown): boolean {
  if (e instanceof AppError) return e.code === 'NETWORK';
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) return true;
  const m = (e as PgLikeError)?.message ?? '';
  return /Failed to fetch|NetworkError|Load failed|network request failed/i.test(m);
}

/** Convert a Supabase/PostgREST/Auth error into an AppError with an actionable message. */
export function toAppError(e: unknown, fallback = 'That did not work. Please try again.'): AppError {
  if (e instanceof AppError) return e;
  if (isNetworkError(e)) return new AppError('NETWORK', FRIENDLY.NETWORK, { retryable: true });
  const err = (e ?? {}) as PgLikeError;
  const code = err.message && FRIENDLY[err.message] ? err.message : null;
  if (code) {
    // RPCs put a specific, human explanation in HINT ("Only 3 bags of Rice left.").
    return new AppError(code, err.hint || FRIENDLY[code], { detail: parseDetail(err.details) });
  }
  if (err.code === '42501' || /permission denied|row-level security/i.test(err.message ?? '')) {
    return new AppError('FORBIDDEN', FRIENDLY.FORBIDDEN);
  }
  if (err.status === 401 || /JWT expired|invalid jwt/i.test(err.message ?? '')) {
    return new AppError('NOT_AUTHENTICATED', FRIENDLY.NOT_AUTHENTICATED);
  }
  if (err.status && err.status >= 500) {
    return new AppError('SERVER', 'Vendora could not reach its server just now. Nothing was saved. Please try again.', { retryable: true });
  }
  return new AppError('UNKNOWN', err.message && err.message.length < 160 ? `${fallback} (${err.message})` : fallback, { retryable: true });
}

/** Map Supabase Auth errors to plain language. */
export function authErrorMessage(e: unknown): string {
  if (isNetworkError(e)) return FRIENDLY.NETWORK;
  const m = ((e as PgLikeError)?.message ?? '').toLowerCase();
  if (m.includes('invalid login credentials')) return 'Email or password is not correct. Check them and try again, or reset your password.';
  if (m.includes('email not confirmed')) return 'Please confirm your email first. Check your inbox for the link we sent.';
  if (m.includes('already registered') || m.includes('already been registered') || m.includes('user already exists'))
    return 'An account already uses this email. Sign in instead, or reset your password.';
  if (m.includes('password') && (m.includes('at least') || m.includes('short') || m.includes('weak')))
    return 'Password is too weak. Use at least 8 characters with letters and numbers.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Please wait a minute and try again.';
  if (m.includes('invalid email') || m.includes('unable to validate email')) return 'That email address does not look right.';
  return 'We could not complete that. Please try again.';
}
