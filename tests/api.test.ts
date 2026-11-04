import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAuthConfig, registerAuthRoutes } from '../src/server/auth.js';
import { FinanceStore } from '../src/server/db.js';
import { registerMcpRoutes } from '../src/server/mcp.js';
import { registerApiRoutes } from '../src/server/routes.js';

describe('Skyday Finance API, Partner Privacy Scope & MCP Connector', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyday-fin-test-'));
  let store: FinanceStore;
  const app = Fastify();

  beforeAll(async () => {
    process.env.AUTH_MODE = 'dev';
    store = new FinanceStore(tmpDir);
    const cfg = loadAuthConfig();
    await app.register(fastifyCookie);
    await app.register(fastifyMultipart);
    registerAuthRoutes(app, store, cfg);
    registerApiRoutes(app, store, cfg);
    registerMcpRoutes(app, store, cfg);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    store.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns status ok on /healthz without leaking private data', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'skyday-finance' });
  });

  it('enforces Partner Privacy Scope between Wadera and Walter', async () => {
    // Set Wadera personal workspace to strictly 'private'
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/settings/preferences',
      headers: { 'x-dev-user': 'wadera' },
      payload: { partnerVisibility: 'private' },
    });
    expect(patchRes.statusCode).toBe(200);

    // Walter queries wealth overview -> Wadera's personal net worth must be hidden (null)
    const walterWealth = await app.inject({
      method: 'GET',
      url: '/api/wealth/overview',
      headers: { 'x-dev-user': 'walter' },
    });
    expect(walterWealth.statusCode).toBe(200);
    const wData = walterWealth.json();
    expect(wData.partnerWealth.visibility).toBe('private');
    expect(wData.partnerWealth.netWorthMinor).toBeNull();
    // Ensure none of Wadera's personal belongings ('ast-emtb') leak into Walter's visible asset list
    expect(wData.assets.some((a: { id: string }) => a.id === 'ast-emtb')).toBe(false);

    // Switch Wadera back to 'totals_only' -> aggregate appears in family wealth, items still hidden
    await app.inject({
      method: 'PATCH',
      url: '/api/settings/preferences',
      headers: { 'x-dev-user': 'wadera' },
      payload: { partnerVisibility: 'totals_only' },
    });
    const walterWealth2 = await app.inject({
      method: 'GET',
      url: '/api/wealth/overview',
      headers: { 'x-dev-user': 'walter' },
    });
    const wData2 = walterWealth2.json();
    expect(wData2.partnerWealth.visibility).toBe('totals_only');
    expect(typeof wData2.partnerWealth.netWorthMinor).toBe('number');
    expect(wData2.assets.some((a: { id: string }) => a.id === 'ast-emtb')).toBe(false);
  });

  it('authenticates scoped MCP API keys and logs multi-currency receipts into pots', async () => {
    const keyRes = await app.inject({
      method: 'POST',
      url: '/api/settings/api-keys',
      headers: { 'x-dev-user': 'wadera' },
      payload: { label: 'Test Receipt Bot' },
    });
    const { rawToken } = keyRes.json() as { rawToken: string };
    expect(rawToken.startsWith('skf_')).toBe(true);

    const mcpRes = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { Authorization: `Bearer ${rawToken}` },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'log_expense_receipt',
          arguments: {
            workspaceId: 'ws-home',
            potId: 'pot-food',
            merchant: 'Lidl',
            description: 'Receipt photo via MCP',
            amountMajor: 40.0,
            currency: 'EUR',
            spentDate: '2026-11-04',
            items: [{ name: 'Butter & Cheese', subCategory: 'Dairy', amountMajor: 12.0 }],
          },
        },
      },
    });
    expect(mcpRes.statusCode).toBe(200);
    const body = mcpRes.json();
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.saved).toBe(true);
    // €40.00 @ 0.85 -> £34.00
    expect(parsed.convertedDefaultMajor).toBe(34);
  });
});
