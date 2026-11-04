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

  it('promotes any leaf item into a Pot when a sub-pot or item is added inside it without double counting', async () => {
    // Promote 'ob-energy' (£215/mo under 'pot-housing') into a Pot with a child 'Peak Tariff' (£95/mo)
    const promRes = await app.inject({
      method: 'POST',
      url: '/api/pots/promote-item',
      headers: { 'x-dev-user': 'wadera' },
      payload: {
        itemKind: 'obligation',
        itemId: 'ob-energy',
        promoteMode: 'envelope',
        child: {
          kind: 'pot',
          name: 'Peak Tariff',
          amountMinor: 9500,
          currency: 'GBP',
        },
      },
    });
    expect(promRes.statusCode).toBe(200);
    const promData = promRes.json() as { ok: boolean; newPotId: string; childId: string };
    expect(promData.ok).toBe(true);

    // Verify 'pot-housing' total did not double-count the £215 energy envelope + £95 sub-pot
    const budgetRes = await app.inject({
      method: 'GET',
      url: '/api/budget/month?ym=2026-11&scope=shared',
      headers: { 'x-dev-user': 'wadera' },
    });
    expect(budgetRes.statusCode).toBe(200);
    const bData = budgetRes.json();
    const housingNode = bData.potTree.find((n: { pot: { id: string } }) => n.pot.id === 'pot-housing');
    const promotedNode = housingNode.children.find((n: { pot: { id: string } }) => n.pot.id === promData.newPotId);
    expect(promotedNode).toBeTruthy();
    expect(promotedNode.effectiveTotalDisplayMinor).toBe(21500); // £215 envelope preserved, not £215 + £95!
    expect(promotedNode.unallocatedEnvelopeDisplayMinor).toBe(12000); // £120 unallocated left
  });

  it('supports multi-workspace creation (Company A), local account login, and strict external isolation', async () => {
    // 1. Wadera creates a 'Company A' workspace
    const wsRes = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { 'x-dev-user': 'wadera' },
      payload: { name: 'Company A', kind: 'company' },
    });
    expect(wsRes.statusCode).toBe(200);
    const companyWsId = wsRes.json().workspace.id as string;

    // 2. Wadera creates a local account for Brother Marek (PL locale, PLN currency) without granting ws-home
    const usrRes = await app.inject({
      method: 'POST',
      url: '/api/users/local',
      headers: { 'x-dev-user': 'wadera' },
      payload: {
        handle: 'marek',
        displayName: 'Brother Marek',
        password: 'secretPassword123',
        locale: 'pl',
        defaultCurrency: 'PLN',
        sharedWorkspaceGrants: [{ workspaceId: companyWsId, role: 'editor' }],
      },
    });
    expect(usrRes.statusCode).toBe(200);

    // 3. Marek logs in via POST /api/auth/local/login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/local/login',
      payload: { username: 'marek', password: 'secretPassword123' },
    });
    expect(loginRes.statusCode).toBe(200);
    const cookieHeader = loginRes.headers['set-cookie'];
    const sessionCookie = Array.isArray(cookieHeader) ? cookieHeader[0].split(';')[0] : String(cookieHeader).split(';')[0];

    // 4. Marek fetches /api/bootstrap -> sees his own personal workspace + shared Company A, but NOT Wadera/Walter's ws-home!
    const bootRes = await app.inject({
      method: 'GET',
      url: '/api/bootstrap',
      headers: { cookie: sessionCookie },
    });
    expect(bootRes.statusCode).toBe(200);
    const marekBoot = bootRes.json();
    expect(marekBoot.user.locale).toBe('pl');
    expect(marekBoot.user.defaultCurrency).toBe('PLN');
    const visibleWsIds = marekBoot.workspaces.map((w: { id: string }) => w.id);
    expect(visibleWsIds).toContain(companyWsId);
    expect(visibleWsIds).not.toContain('ws-home');
    expect(visibleWsIds).not.toContain('ws-wadera');
  });

  it('computes Smart Payday-Bridge Cashflow (Previous Month Overflow + Dotted Upcoming 27th Salary + Next Month Needed Before Salary) and toggles salary arrival', async () => {
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/budget/month?ym=2026-11&scope=all',
      headers: { 'x-dev-user': 'wadera' },
    });
    expect(res1.statusCode).toBe(200);
    const b1 = res1.json();

    expect(b1.cashflowBridge.primaryPaydayDay).toBe(27);
    expect(b1.cashflowBridge.overflowInMinor).toBe(595000); // £5,950 overflow from Oct 27th salary
    expect(b1.cashflowBridge.upcomingSalaryTotalMinor).toBe(595000); // £5,950 upcoming Nov 27th salary
    expect(b1.cashflowBridge.upcomingSalaryReceivedMinor).toBe(0); // Not yet ticked received!
    expect(b1.cashflowBridge.upcomingSalaryPendingMinor).toBe(595000);
    expect(b1.cashflowBridge.nextMonthPreSalaryMinor).toBeGreaterThan(0);

    // Tick Wadera's Nov 27th salary as received on the Monthly Timeline Tracker
    const togRes = await app.inject({
      method: 'POST',
      url: '/api/incomes/inc-wadera-cur/toggle-received',
      headers: { 'x-dev-user': 'wadera' },
      payload: { yearMonth: '2026-11', received: true },
    });
    expect(togRes.statusCode).toBe(200);
    expect(togRes.json().isReceivedThisMonth).toBe(true);

    const res2 = await app.inject({
      method: 'GET',
      url: '/api/budget/month?ym=2026-11&scope=all',
      headers: { 'x-dev-user': 'wadera' },
    });
    const b2 = res2.json();
    expect(b2.cashflowBridge.upcomingSalaryReceivedMinor).toBe(595000);
    expect(b2.cashflowBridge.upcomingSalaryPendingMinor).toBe(0);
    // Still keeps overflowInMinor (£5,950) separate from upcomingSalary (£5,950) so there is never a fake £11.9k pool!
    expect(b2.cashflowBridge.overflowInMinor).toBe(595000);
  });
});
