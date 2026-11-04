import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserProfile } from '../shared/types.js';
import type { FinanceStore } from './db.js';

const SESSION_COOKIE = 'skyday_fin_sess';
const OIDC_STATE_COOKIE = 'skyday_fin_oidc';

export interface AuthConfig {
  authMode: 'authentik' | 'dev';
  sessionSecret: string;
  publicBaseUrl: string;
  authentikPublicUrl: string;
  authentikInternalUrl: string;
  authentikSlug: string;
  clientId: string;
  clientSecret: string;
  trustedProxyPrefixes: string[];
}

export function loadAuthConfig(): AuthConfig {
  const isProd = process.env.NODE_ENV === 'production';
  const rawMode = (process.env.AUTH_MODE || (isProd ? 'authentik' : 'dev')).toLowerCase();
  const authMode: 'authentik' | 'dev' = rawMode === 'dev' && !isProd ? 'dev' : 'authentik';

  const sessionSecret =
    process.env.SESSION_SECRET ||
    (isProd ? crypto.randomBytes(32).toString('hex') : 'dev-local-session-secret-skyday-finance-3020');

  return {
    authMode,
    sessionSecret,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'https://finance.skyday.eu').replace(/\/+$/, ''),
    authentikPublicUrl: (process.env.AUTHENTIK_PUBLIC_URL || 'https://auth.skyday.eu').replace(/\/+$/, ''),
    authentikInternalUrl: (
      process.env.AUTHENTIK_INTERNAL_URL ||
      process.env.AUTHENTIK_PUBLIC_URL ||
      'https://auth.skyday.eu'
    ).replace(/\/+$/, ''),
    authentikSlug: process.env.AUTHENTIK_APP_SLUG || 'skyday-finance',
    clientId: process.env.AUTHENTIK_CLIENT_ID || '',
    clientSecret: process.env.AUTHENTIK_CLIENT_SECRET || '',
    trustedProxyPrefixes: (process.env.TRUSTED_PROXY_PREFIXES || '10.100.12.,10.100.2.,172.,127.0.0.1,::ffff:10.100.')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function signPayload(payloadObj: Record<string, unknown>, secret: string): string {
  const data = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyPayload<T>(token: string | undefined, secret: string): T | null {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.', 2);
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function base64UrlSha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

function isTrustedProxyPeer(remoteAddress: string | undefined, prefixes: string[]): boolean {
  if (!remoteAddress) return false;
  return prefixes.some((p) => remoteAddress === p || remoteAddress.startsWith(p));
}

export function mapIdentityToUser(
  store: FinanceStore,
  claims: {
    username?: string;
    email?: string;
    groups?: string[];
  }
): UserProfile | null {
  const uname = (claims.username || '').trim().toLowerCase();
  const email = (claims.email || '').trim().toLowerCase();
  const groups = (claims.groups || []).map((g) => g.toLowerCase());

  const users = store.getUsers();
  const wadera = users.find((u) => u.handle === 'wadera') ?? null;
  const walter = users.find((u) => u.handle === 'walter') ?? null;

  // Explicit named account mapping for Wadera & Walter
  if (
    uname === 'wadera' ||
    uname === 'paulina' ||
    uname === 'pstopa' ||
    email === 'pstopa@skyday.eu' ||
    email === 'wadera@skyday.eu'
  ) {
    // Sync actual email if Authentik supplies one
    return wadera;
  }

  if (
    uname === 'walter' ||
    uname === 'wojciech' ||
    uname === 'wpoznanski' ||
    uname === 'poznanski.wojciech@gmail.com' ||
    email === 'poznanski.wojciech@gmail.com' ||
    email === 'wpoznanski@skyday.eu' ||
    email === 'walter@skyday.eu'
  ) {
    return walter;
  }

  // Fallback group-based mapping only for authorized human trust tiers
  if (groups.includes('trust-human-owner')) return wadera;
  if (groups.includes('trust-human-trusted') && uname && !uname.includes('hermes') && !uname.includes('agent')) {
    return walter;
  }

  return null;
}

export function resolveRequestUser(
  req: FastifyRequest,
  store: FinanceStore,
  cfg: AuthConfig
): { user: UserProfile | null; via: 'bearer' | 'session' | 'forward_auth' | 'dev' | 'none' } {
  // 1. Scoped Bearer API Key (MCP / Agent automation)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const rawKey = authHeader.slice(7).trim();
    const apiUser = store.verifyApiKey(rawKey);
    if (apiUser) return { user: apiUser, via: 'bearer' };
    return { user: null, via: 'none' };
  }

  // 2. Signed Session Cookie (from Authentik OIDC callback or dev switcher)
  const rawCookie = req.cookies?.[SESSION_COOKIE];
  const sess = verifyPayload<{ uid: string; exp: number }>(rawCookie, cfg.sessionSecret);
  if (sess && sess.exp > Date.now()) {
    const u = store.getUserById(sess.uid);
    if (u) return { user: u, via: 'session' };
  }

  // 3. Trusted Authentik ForwardAuth proxy headers
  const fwdUser = req.headers['x-authentik-username'] as string | undefined;
  const fwdEmail = req.headers['x-authentik-email'] as string | undefined;
  if ((fwdUser || fwdEmail) && isTrustedProxyPeer(req.socket.remoteAddress, cfg.trustedProxyPrefixes)) {
    const rawGroups = (req.headers['x-authentik-groups'] as string | undefined) || '';
    const groups = rawGroups
      .split(/[|,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const mapped = mapIdentityToUser(store, { username: fwdUser, email: fwdEmail, groups });
    if (mapped) return { user: mapped, via: 'forward_auth' };
  }

  // 4. Local Dev Mode ONLY (strictly disabled in production)
  if (cfg.authMode === 'dev') {
    const devHeader = (req.headers['x-dev-user'] as string | undefined) || 'wadera';
    const u = store.getUsers().find((x) => x.handle === devHeader) ?? store.getUsers()[0] ?? null;
    return { user: u, via: 'dev' };
  }

  return { user: null, via: 'none' };
}

export function registerAuthRoutes(app: FastifyInstance, store: FinanceStore, cfg: AuthConfig): void {
  // Public auth status probe (never leaks financial data)
  app.get('/api/auth/status', async (req) => {
    const { user, via } = resolveRequestUser(req, store, cfg);
    return {
      authenticated: Boolean(user),
      via,
      authMode: cfg.authMode,
      oidcConfigured: Boolean(cfg.clientId && cfg.clientSecret),
      loginUrl: '/api/auth/oidc/login',
      user: user
        ? {
            id: user.id,
            handle: user.handle,
            displayName: user.displayName,
            defaultCurrency: user.defaultCurrency,
          }
        : null,
      devUsers: cfg.authMode === 'dev' ? store.getUsers().map((u) => ({ handle: u.handle, displayName: u.displayName })) : undefined,
    };
  });

  // Dev user switcher (only active when authMode === 'dev')
  app.post('/api/auth/dev-switch', async (req, reply) => {
    if (cfg.authMode !== 'dev') {
      return reply.code(403).send({ error: 'Dev switcher disabled in production' });
    }
    const body = (req.body || {}) as { handle?: string };
    const target = store.getUsers().find((u) => u.handle === body.handle);
    if (!target) return reply.code(400).send({ error: 'Unknown user handle' });

    const token = signPayload({ uid: target.id, exp: Date.now() + 14 * 86400_000 }, cfg.sessionSecret);
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 14 * 86400,
    });
    return { ok: true, user: target };
  });

  // Native Authentik OIDC Login Initiation (Authorization Code + PKCE S256)
  app.get('/api/auth/oidc/login', async (_req, reply) => {
    if (!cfg.clientId || !cfg.clientSecret) {
      return reply.code(503).send({
        error: 'OIDC client is not yet configured in environment.',
      });
    }

    const state = crypto.randomBytes(24).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = base64UrlSha256(codeVerifier);

    const oidcCookie = signPayload(
      { state, codeVerifier, exp: Date.now() + 10 * 60_000 },
      cfg.sessionSecret
    );
    reply.setCookie(OIDC_STATE_COOKIE, oidcCookie, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.publicBaseUrl.startsWith('https://'),
      maxAge: 600,
    });

    const redirectUri = `${cfg.publicBaseUrl}/api/auth/oidc/callback`;
    const authUrl = new URL(`${cfg.authentikPublicUrl}/application/o/authorize/`);
    authUrl.searchParams.set('client_id', cfg.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return reply.redirect(authUrl.toString());
  });

  // Native Authentik OIDC Callback
  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const query = (req.query || {}) as { code?: string; state?: string; error?: string };
    if (query.error) {
      return reply.code(401).type('text/html').send(`<h3>SSO Login denied: ${query.error}</h3><a href="/">Return</a>`);
    }

    const pending = verifyPayload<{ state: string; codeVerifier: string; exp: number }>(
      req.cookies?.[OIDC_STATE_COOKIE],
      cfg.sessionSecret
    );
    reply.clearCookie(OIDC_STATE_COOKIE, { path: '/' });

    if (!pending || pending.exp < Date.now() || !query.code || query.state !== pending.state) {
      return reply.code(400).type('text/html').send(`<h3>Invalid or expired SSO state.</h3><a href="/api/auth/oidc/login">Try again</a>`);
    }

    const redirectUri = `${cfg.publicBaseUrl}/api/auth/oidc/callback`;
    const tokenEndpoint = `${cfg.authentikInternalUrl}/application/o/token/`;
    const userinfoEndpoint = `${cfg.authentikInternalUrl}/application/o/userinfo/`;

    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('client_id', cfg.clientId);
    form.set('client_secret', cfg.clientSecret);
    form.set('code', query.code);
    form.set('redirect_uri', redirectUri);
    form.set('code_verifier', pending.codeVerifier);

    const tokenRes = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });

    if (!tokenRes.ok) {
      req.log.error({ status: tokenRes.status }, 'Authentik token exchange failed');
      return reply.code(401).type('text/html').send(`<h3>Authentik token exchange failed (HTTP ${tokenRes.status}).</h3><a href="/">Return</a>`);
    }

    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      return reply.code(401).send({ error: 'Missing access token from Authentik' });
    }

    const uiRes = await fetch(userinfoEndpoint, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
      },
    });

    if (!uiRes.ok) {
      return reply.code(401).send({ error: 'Authentik userinfo lookup failed' });
    }

    const userInfo = (await uiRes.json()) as {
      preferred_username?: string;
      email?: string;
      name?: string;
      groups?: string[];
    };

    const mappedUser = mapIdentityToUser(store, {
      username: userInfo.preferred_username,
      email: userInfo.email,
      groups: Array.isArray(userInfo.groups) ? userInfo.groups : [],
    });

    if (!mappedUser) {
      return reply
        .code(403)
        .type('text/html')
        .send(`<h3>Access denied: your Authentik account is not authorized for Skyday Finance.</h3>`);
    }

    const sessToken = signPayload(
      { uid: mappedUser.id, exp: Date.now() + 14 * 86400_000 },
      cfg.sessionSecret
    );
    reply.setCookie(SESSION_COOKIE, sessToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.publicBaseUrl.startsWith('https://'),
      maxAge: 14 * 86400,
    });

    return reply.redirect('/');
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return {
      ok: true,
      endSessionUrl: cfg.clientId
        ? `${cfg.authentikPublicUrl}/application/o/${cfg.authentikSlug}/end-session/`
        : '/',
    };
  });
}

export function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
  store: FinanceStore,
  cfg: AuthConfig
): UserProfile | null {
  const { user } = resolveRequestUser(req, store, cfg);
  if (!user) {
    reply.code(401).send({ error: 'Authentication required', loginUrl: '/api/auth/oidc/login' });
    return null;
  }
  return user;
}
