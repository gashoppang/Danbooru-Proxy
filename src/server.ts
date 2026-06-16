import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { URL } from 'node:url';

type Env = NodeJS.ProcessEnv;

type FetchLike = typeof fetch;

interface DanbooruEgressConfig {
  host: string;
  port: number;
  origin: string;
  token: string;
  upstreamTimeoutMs: number;
  maxPathLength: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  userAgent: string;
}

interface Dependencies {
  fetchImpl?: FetchLike;
  now?: () => number;
}

interface JsonPayload {
  [key: string]: unknown;
}

const DEFAULT_ALLOWED_PATHS = new Set([
  '/tags.json',
  '/tag_aliases.json',
  '/wiki_pages.json',
  '/posts.json',
  '/related_tag.json',
  '/tag_implications.json',
]);

function parsePositiveInteger(value: string | undefined, fallback: number, min = 1, max = 120000) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return Math.min(max, parsed);
}

function normalizeBaseUrl(value: string | undefined, fallback: string) {
  const raw = String(value || '').trim() || fallback;
  return raw.replace(/\/+$/, '');
}

function sanitizePathPreview(value: string, maxLength = 180) {
  return value.replace(/\s+/g, ' ').slice(0, maxLength);
}

export function buildConfigFromEnv(env: Env = process.env): DanbooruEgressConfig {
  return {
    host: String(env.DANBOORU_EGRESS_HOST || env.HOST || '0.0.0.0').trim() || '0.0.0.0',
    port: parsePositiveInteger(env.DANBOORU_EGRESS_PORT || env.PORT, 8787, 1, 65535),
    origin: normalizeBaseUrl(env.DANBOORU_ORIGIN, 'https://danbooru.donmai.us'),
    token: String(env.DANBOORU_EGRESS_TOKEN || '').trim(),
    upstreamTimeoutMs: parsePositiveInteger(env.DANBOORU_EGRESS_TIMEOUT_MS, 15000, 1000, 120000),
    maxPathLength: parsePositiveInteger(env.DANBOORU_EGRESS_MAX_PATH_LENGTH, 4096, 256, 16384),
    rateLimitWindowMs: parsePositiveInteger(
      env.DANBOORU_EGRESS_RATE_LIMIT_WINDOW_MS,
      60000,
      1000,
      3600000,
    ),
    rateLimitMax: parsePositiveInteger(env.DANBOORU_EGRESS_RATE_LIMIT_MAX, 600, 1, 100000),
    userAgent:
      String(env.DANBOORU_EGRESS_USER_AGENT || '').trim() ||
      'prompt-smith-danbooru-egress/1.0',
  };
}

class FixedWindowRateLimiter {
  private buckets = new Map<string, { resetAt: number; count: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly now: () => number,
  ) {}

  allow(key: string) {
    const current = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      this.buckets.set(key, { resetAt: current + this.windowMs, count: 1 });
      return true;
    }

    bucket.count += 1;
    return bucket.count <= this.max;
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: JsonPayload | unknown[]) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function getBearerToken(req: IncomingMessage) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return '';
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireAuthorization(req: IncomingMessage, config: DanbooruEgressConfig) {
  if (!config.token) {
    return {
      ok: false,
      status: 503,
      error: 'egress_token_not_configured',
    };
  }

  if (getBearerToken(req) !== config.token) {
    return {
      ok: false,
      status: 401,
      error: 'unauthorized',
    };
  }

  return { ok: true, status: 200, error: null };
}

function buildTargetUrl(pathValue: string | null, config: DanbooruEgressConfig) {
  if (!pathValue) {
    return { ok: false, status: 400, error: 'missing_path', url: null };
  }

  if (pathValue.length > config.maxPathLength) {
    return { ok: false, status: 414, error: 'path_too_long', url: null };
  }

  if (!pathValue.startsWith('/')) {
    return { ok: false, status: 400, error: 'path_must_be_relative', url: null };
  }

  let target: URL;
  try {
    target = new URL(pathValue, config.origin);
  } catch {
    return { ok: false, status: 400, error: 'invalid_path', url: null };
  }

  if (target.origin !== config.origin) {
    return { ok: false, status: 400, error: 'target_origin_not_allowed', url: null };
  }

  if (!DEFAULT_ALLOWED_PATHS.has(target.pathname)) {
    return { ok: false, status: 403, error: 'target_path_not_allowed', url: null };
  }

  return { ok: true, status: 200, error: null, url: target };
}

async function fetchUpstreamJson(
  target: URL,
  config: DanbooruEgressConfig,
  fetchImpl: FetchLike,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

  try {
    const response = await fetchImpl(target.toString(), {
      headers: {
        accept: 'application/json',
        'user-agent': config.userAgent,
      },
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    if (!contentType.toLowerCase().includes('application/json')) {
      return {
        ok: false,
        status: 502,
        payload: {
          error: 'upstream_non_json_response',
          upstreamStatus: response.status,
          upstreamContentType: contentType || null,
          bodyPreview: sanitizePathPreview(text, 200),
        },
      };
    }

    try {
      JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: 502,
        payload: {
          error: 'upstream_invalid_json_response',
          upstreamStatus: response.status,
          upstreamContentType: contentType || null,
        },
      };
    }

    return {
      ok: response.ok,
      status: response.status,
      payload: JSON.parse(text) as JsonPayload | unknown[],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'upstream_fetch_failed';
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      payload: {
        error: timedOut ? 'upstream_timeout' : 'upstream_fetch_failed',
        message,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createDanbooruEgressServer(
  config: DanbooruEgressConfig,
  dependencies: Dependencies = {},
): Server {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const now = dependencies.now || Date.now;
  const limiter = new FixedWindowRateLimiter(config.rateLimitWindowMs, config.rateLimitMax, now);

  return createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'danbooru-egress',
      });
      return;
    }

    if (req.method !== 'GET' || requestUrl.pathname !== '/v1/danbooru/fetch') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const auth = requireAuthorization(req, config);
    if (!auth.ok) {
      sendJson(res, auth.status, { error: auth.error });
      return;
    }

    const clientKey = req.socket.remoteAddress || 'unknown';
    if (!limiter.allow(clientKey)) {
      sendJson(res, 429, { error: 'rate_limited' });
      return;
    }

    const targetResult = buildTargetUrl(requestUrl.searchParams.get('path'), config);
    if (!targetResult.ok || !targetResult.url) {
      sendJson(res, targetResult.status, { error: targetResult.error });
      return;
    }

    const upstream = await fetchUpstreamJson(targetResult.url, config, fetchImpl);
    sendJson(res, upstream.status, upstream.payload);
  });
}

export function startServerFromEnv(env: Env = process.env) {
  const config = buildConfigFromEnv(env);
  const server = createDanbooruEgressServer(config);
  server.listen(config.port, config.host, () => {
    process.stdout.write(
      `${JSON.stringify({
        event: 'danbooru_egress_started',
        host: config.host,
        port: config.port,
        origin: config.origin,
        tokenConfigured: Boolean(config.token),
      })}\n`,
    );
  });
  return server;
}

if (require.main === module) {
  startServerFromEnv();
}
