/**
 * Billing REST client. BILLING_API_URL is the API gateway in the cloud (Phase 4) and the
 * billing-api itself locally. Every call returns { status, body } so the executor can turn
 * HTTP errors into tool results; only network failures throw (NetworkError).
 */

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

export interface HttpResult {
  status: number;
  // The API's JSON (success body or { error: { code, message, traceId, ... } }).
  body: Record<string, unknown>;
}

export interface Session {
  subscriberNo: string;
  role: 'SUBSCRIBER' | 'ADMIN';
  /** Kept in memory only; never logged or traced. */
  token: string;
  expiresAt: Date;
  expired: boolean;
}

export interface Period {
  month: number;
  year: number;
}

export interface PayBody extends Period {
  amount: number;
  transactionId: string;
}

/** Reads (does not verify) the JWT payload; the API verifies signatures. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('malformed access token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

export class BillingClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
    private readonly timeoutMs = 15_000,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async login(subscriberNo: string, password: string): Promise<Session> {
    const r = await this.request('POST', '/api/v1/auth/login', {
      body: { subscriberNo, password },
    });
    if (r.status !== 200) {
      const msg = (r.body.error as { message?: string } | undefined)?.message;
      throw new LoginError(
        r.status === 401
          ? 'Wrong subscriber number or password.'
          : (msg ?? `Login failed (HTTP ${r.status})`),
      );
    }
    const token = String(r.body.accessToken);
    const claims = decodeJwtPayload(token);
    return {
      subscriberNo: String(claims.sub),
      role: claims.role === 'ADMIN' ? 'ADMIN' : 'SUBSCRIBER',
      token,
      expiresAt: new Date(Number(claims.exp) * 1000),
      expired: false,
    };
  }

  /** Public by spec, but the agent only ever passes the session's own number. */
  queryBill(session: Session, p: Period): Promise<HttpResult> {
    return this.request(
      'GET',
      `/api/v1/bills/${enc(session.subscriberNo)}?month=${p.month}&year=${p.year}`,
      { session },
    );
  }

  queryBillDetailed(
    session: Session,
    p: Period,
    page: number,
    pageSize: number,
  ): Promise<HttpResult> {
    return this.request(
      'GET',
      `/api/v1/bills/${enc(session.subscriberNo)}/detailed?month=${p.month}&year=${p.year}&page=${page}&pageSize=${pageSize}`,
      { session },
    );
  }

  pay(session: Session, body: PayBody): Promise<HttpResult> {
    return this.request('POST', '/api/v1/payments', {
      session,
      body: { subscriberNo: session.subscriberNo, ...body },
    });
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { session?: Session; body?: unknown },
  ): Promise<HttpResult> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.session) headers.Authorization = `Bearer ${opts.session.token}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new NetworkError(`Cannot reach the billing API at ${this.base}`, { cause: err });
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch {
      // empty or non-JSON body (e.g. a gateway error page): status alone decides
    }
    return { status: res.status, body };
  }
}

const enc = encodeURIComponent;
