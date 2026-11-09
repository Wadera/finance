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

  it('satisfies all MCP reconciliation & internal transfer acceptance scenarios', async () => {
    const callMcp = async (toolName: string, args: Record<string, unknown>) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { 'x-dev-user': 'wadera' },
        payload: {
          jsonrpc: '2.0',
          id: Math.floor(Math.random() * 100000),
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args,
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result?.isError).not.toBe(true);
      return JSON.parse(body.result.content[0].text);
    };

    // 0. Verify tools/list exposes all required MCP tools
    const listToolsRes = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { 'x-dev-user': 'wadera' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    const toolNames = (listToolsRes.json().result.tools as Array<{ name: string }>).map((t) => t.name);
    for (const requiredTool of [
      'list_accounts',
      'get_account',
      'set_account_balance_snapshot',
      'list_transactions',
      'get_transaction',
      'upsert_transaction',
      'delete_transaction',
      'create_transfer',
      'update_transfer',
      'delete_transfer',
      'list_transfers',
      'list_upcoming_obligations',
      'mark_obligation_paid',
      'update_obligation_schedule',
      'get_monthly_budget',
      'reconcile_batch',
      'reverse_reconciliation_batch',
    ]) {
      expect(toolNames).toContain(requiredTool);
    }

    // Seed the 5 UK bank accounts & Klarna MTB obligation + Saver reserves from the reconciliation report
    for (const accPayload of [
      {
        id: 'acc-revolut-joint',
        workspaceId: 'ws-home',
        name: 'Revolut Joint',
        institution: 'Revolut',
        currency: 'GBP',
        balanceMinor: 19789,
        portalUrl: 'https://app.revolut.com',
        notes:
          'Joint household account belonging to Wadera and Walter. £120 was transferred to Club Lloyds on 5 November, leaving £199.38 at that point.',
      },
      {
        id: 'acc-lloyds-club',
        workspaceId: 'ws-wadera',
        name: 'Club Lloyds',
        institution: 'Lloyds Bank',
        currency: 'GBP',
        balanceMinor: 21811,
      },
      {
        id: 'acc-lloyds-classic',
        workspaceId: 'ws-wadera',
        name: 'Lloyds Classic',
        institution: 'Lloyds Bank',
        currency: 'GBP',
        balanceMinor: 24015,
      },
      {
        id: 'acc-lloyds-saver',
        workspaceId: 'ws-wadera',
        name: 'Lloyds Standard Saver',
        institution: 'Lloyds Bank',
        currency: 'GBP',
        balanceMinor: 20000,
      },
      {
        id: 'acc-revolut-personal',
        workspaceId: 'ws-wadera',
        name: 'Revolut Personal',
        institution: 'Revolut',
        currency: 'GBP',
        balanceMinor: 8914,
        pocketMoneyTargetMinor: 14920,
      },
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { 'x-dev-user': 'wadera' },
        payload: accPayload,
      });
      expect(r.statusCode).toBe(200);
    }

    // Seed £486.72 of annual reserves parked on acc-lloyds-saver and Klarna MTB £75.45 monthly obligation
    await app.inject({
      method: 'POST',
      url: '/api/obligations',
      headers: { 'x-dev-user': 'wadera' },
      payload: {
        id: 'ob-saver-reserve-test',
        workspaceId: 'ws-wadera',
        potId: 'pot-veh-maint',
        accountId: 'acc-lloyds-classic',
        preserveAccountId: 'acc-lloyds-saver',
        name: 'Annual Car & Home Reserves',
        amountMinor: 60000,
        currency: 'GBP',
        cadence: 'annual',
        intervalMonths: 12,
        nextDueDate: '2027-06-01',
        preservedMinor: 48672,
        autoPreserve: true,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/obligations',
      headers: { 'x-dev-user': 'wadera' },
      payload: {
        id: 'ob-emtb-klarna',
        workspaceId: 'ws-wadera',
        potId: 'pot-ai-hobbies',
        accountId: 'acc-lloyds-classic',
        name: 'Klarna MTB',
        amountMinor: 7545,
        currency: 'GBP',
        cadence: 'monthly',
        intervalMonths: 1,
        nextDueDate: '2026-11-05',
        preservedMinor: 0,
        autoPreserve: false,
      },
    });

    // Acceptance Scenario 4: Changing only an account balance preserves its notes, owner/workspace, currency, portalUrl & metadata
    const jointBefore = await callMcp('get_account', { accountId: 'acc-revolut-joint' });
    expect(jointBefore.account.notes).toContain('Wadera and Walter');
    const originalPortalUrl = jointBefore.account.portalUrl;
    const originalWorkspaceId = jointBefore.account.workspaceId;

    // Update balance via REST POST /api/accounts without supplying notes or portalUrl
    const restAccPatch = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { 'x-dev-user': 'wadera' },
      payload: {
        id: 'acc-revolut-joint',
        balanceMinor: 31938,
      },
    });
    expect(restAccPatch.statusCode).toBe(200);
    const jointAfterRest = await callMcp('get_account', { accountId: 'acc-revolut-joint' });
    expect(jointAfterRest.account.balanceMinor).toBe(31938);
    expect(jointAfterRest.account.notes).toContain('Wadera and Walter');
    expect(jointAfterRest.account.portalUrl).toBe(originalPortalUrl);
    expect(jointAfterRest.account.workspaceId).toBe(originalWorkspaceId);

    // Acceptance Scenario 1: Reconcile Joint's £319.38 statement to £133.44 available after:
    // - £120.00 transfer to Club Lloyds (leaving £199.38)
    // - £23.49 Amazon (posted)
    // - £1.49 Nevison (posted)
    // - £40.96 Nevison pending authorization
    // Promoting that pending authorization to posted later must NOT debit available cash or budget twice.
    await callMcp('set_account_balance_snapshot', {
      accountId: 'acc-revolut-joint',
      availableBalanceMajor: 319.38,
      bookedBalanceMajor: 319.38,
      pendingDebitMajor: 0,
      observedAt: '2026-11-05T08:00:00Z',
      source: 'statement',
    });

    const clubBeforeTransfer = (await callMcp('get_account', { accountId: 'acc-lloyds-club' })).account.balanceMinor;

    // Execute £120 internal transfer from Revolut Joint -> Club Lloyds
    const trfRes = await callMcp('create_transfer', {
      fromAccountId: 'acc-revolut-joint',
      toAccountId: 'acc-lloyds-club',
      amountMajor: 120.0,
      transferDate: '2026-11-05',
      description: 'Joint to Club Lloyds transfer',
      idempotencyKey: 'trf-joint-club-2026-11-05',
    });
    expect(trfRes.fromAccountAfterMinor).toBe(19938); // £199.38
    expect(trfRes.toAccountAfterMinor).toBe(clubBeforeTransfer + 12000);

    // Retrying the same transfer with the same idempotencyKey is a no-op
    const trfRetry = await callMcp('create_transfer', {
      fromAccountId: 'acc-revolut-joint',
      toAccountId: 'acc-lloyds-club',
      amountMajor: 120.0,
      transferDate: '2026-11-05',
      idempotencyKey: 'trf-joint-club-2026-11-05',
    });
    expect(trfRetry.idempotentReplay).toBe(true);
    expect(trfRetry.fromAccountAfterMinor).toBe(19938);

    // Import £23.49 Amazon (posted), £1.49 Nevison (posted), and £40.96 Nevison (pending)
    await callMcp('upsert_transaction', {
      accountId: 'acc-revolut-joint',
      potId: null,
      merchant: 'Amazon',
      description: 'Uncategorized pending receipt',
      amountMajor: 23.49,
      status: 'posted',
      bankTimestamp: '2026-11-05T13:21:00Z',
      idempotencyKey: 'tx-joint-amazon-2349',
    });
    await callMcp('upsert_transaction', {
      accountId: 'acc-revolut-joint',
      potId: 'pot-food',
      merchant: 'Nevison',
      amountMajor: 1.49,
      status: 'posted',
      bankTimestamp: '2026-11-05T20:29:00Z',
      idempotencyKey: 'tx-joint-nevison-149',
    });
    const pendingRes = await callMcp('upsert_transaction', {
      accountId: 'acc-revolut-joint',
      potId: 'pot-food',
      merchant: 'Nevison',
      description: 'Pending card authorization',
      amountMajor: 40.96,
      status: 'pending',
      bankTimestamp: '2026-11-07T11:15:00Z',
      idempotencyKey: 'tx-joint-nevison-4096',
    });

    // Verify Revolut Joint available balance is now £133.44 (13344 minor) and booked is £174.40 (17440 minor)
    const jointAfterSpend = await callMcp('get_account', { accountId: 'acc-revolut-joint', yearMonth: '2026-11' });
    expect(jointAfterSpend.account.availableBalanceMinor).toBe(13344);
    expect(jointAfterSpend.account.bookedBalanceMinor).toBe(17440);
    expect(jointAfterSpend.account.pendingDebitMinor).toBe(4096);

    // Check monthly budget before promoting pending -> posted
    const budgetWithPending = await callMcp('get_monthly_budget', { yearMonth: '2026-11', scope: 'all' });
    const foodPotBeforePromote = budgetWithPending.potRollups.find((p: { id: string }) => p.id === 'pot-food');
    expect(foodPotBeforePromote.pendingSpendMajor).toBeCloseTo(40.96, 2);
    const totalFoodItemizedBefore = foodPotBeforePromote.itemizedSpendMajor;

    // Now promote the £40.96 pending authorization to 'posted'
    const promoteRes = await callMcp('upsert_transaction', {
      id: pendingRes.transaction.id,
      status: 'posted',
      bankTimestamp: '2026-11-08T09:00:00Z',
    });
    expect(promoteRes.availableDeltaMinor).toBe(0); // Must NOT debit available cash a second time!
    expect(promoteRes.bookedDeltaMinor).toBe(-4096); // Booked balance catches up to available

    const jointAfterPost = await callMcp('get_account', { accountId: 'acc-revolut-joint', yearMonth: '2026-11' });
    expect(jointAfterPost.account.availableBalanceMinor).toBe(13344);
    expect(jointAfterPost.account.bookedBalanceMinor).toBe(13344);

    const budgetAfterPost = await callMcp('get_monthly_budget', { yearMonth: '2026-11', scope: 'all' });
    const foodPotAfterPromote = budgetAfterPost.potRollups.find((p: { id: string }) => p.id === 'pot-food');
    expect(foodPotAfterPromote.pendingSpendMajor).toBe(0);
    expect(foodPotAfterPromote.itemizedSpendMajor).toBeCloseTo(totalFoodItemizedBefore, 2); // Not debited twice in budget!

    // Acceptance Scenario 3: Moving MiPermit £0.80 from 1 November to 31 October changes monthly spend totals and preserves account balance
    const classicBeforeMiPermit = (await callMcp('get_account', { accountId: 'acc-lloyds-classic' })).account.balanceMinor;
    const miPermitCreate = await callMcp('upsert_transaction', {
      accountId: 'acc-lloyds-classic',
      potId: 'pot-car',
      merchant: 'MiPermit',
      amountMajor: 0.8,
      status: 'posted',
      spentDate: '2026-11-01',
      idempotencyKey: 'tx-mipermit-080',
    });
    const classicAfterCreate = (await callMcp('get_account', { accountId: 'acc-lloyds-classic' })).account.balanceMinor;
    expect(classicAfterCreate).toBe(classicBeforeMiPermit - 80);

    const novSpendBeforeMove = (await callMcp('get_monthly_budget', { yearMonth: '2026-11', scope: 'all' })).postedSpendMajor;
    const octSpendBeforeMove = (await callMcp('get_monthly_budget', { yearMonth: '2026-10', scope: 'all' })).postedSpendMajor;

    // Move MiPermit from 2026-11-01 to 2026-10-31T13:09:00Z
    const miPermitMove = await callMcp('upsert_transaction', {
      id: miPermitCreate.transaction.id,
      bankTimestamp: '2026-10-31T13:09:00Z',
    });
    expect(miPermitMove.availableDeltaMinor).toBe(0);
    expect(miPermitMove.accountAfterBalanceMinor).toBe(classicAfterCreate);

    const novSpendAfterMove = (await callMcp('get_monthly_budget', { yearMonth: '2026-11', scope: 'all' })).postedSpendMajor;
    const octSpendAfterMove = (await callMcp('get_monthly_budget', { yearMonth: '2026-10', scope: 'all' })).postedSpendMajor;
    expect(novSpendAfterMove).toBeCloseTo(novSpendBeforeMove - 0.8, 2);
    expect(octSpendAfterMove).toBeCloseTo(octSpendBeforeMove + 0.8, 2);

    // Acceptance Scenario 5: A £200 saver with £486.72 reserved reports £0 free cash, £200 funded reserves, and £286.72 underfunding.
    // And Revolut Personal's £149.20 pocket allowance is capped at its £89.14 account balance.
    await callMcp('set_account_balance_snapshot', {
      accountId: 'acc-lloyds-saver',
      availableBalanceMajor: 200.0,
      observedAt: '2026-11-07T12:00:00Z',
    });
    await callMcp('set_account_balance_snapshot', {
      accountId: 'acc-revolut-personal',
      availableBalanceMajor: 89.14,
      observedAt: '2026-11-07T12:00:00Z',
    });

    const budgetCheck = await callMcp('get_monthly_budget', { yearMonth: '2026-11', scope: 'all' });
    const saverStats = budgetCheck.accounts.find((a: { id: string }) => a.id === 'acc-lloyds-saver');
    expect(saverStats.availableBalanceMajor).toBe(200);
    expect(saverStats.plannedReservesMajor).toBeCloseTo(486.72, 2);
    expect(saverStats.fundedReservesMajor).toBe(200);
    expect(saverStats.freeCashMajor).toBe(0);
    expect(saverStats.reserveShortfallMajor).toBeCloseTo(286.72, 2);

    const revPersonalStats = budgetCheck.accounts.find((a: { id: string }) => a.id === 'acc-revolut-personal');
    expect(revPersonalStats.availableBalanceMajor).toBeCloseTo(89.14, 2);
    expect(revPersonalStats.pocketMoneyAllowanceRemainingMajor).toBeGreaterThan(89.14);
    expect(revPersonalStats.spendablePocketMoneyMajor).toBeCloseTo(89.14, 2);

    // Acceptance Scenario 6: Finite & variable schedules (November Klarna MTB £75.45 paid, December £75.25 due 2026-12-05, no January recurrence)
    // and payment recording dates remain auditable while bank dates are supplied independently.
    const paidNov = await callMcp('mark_obligation_paid', {
      obligationId: 'ob-emtb-klarna',
      yearMonth: '2026-11',
      paid: true,
      amountMajor: 75.45,
      bankDate: '2026-11-05',
      accountId: 'acc-lloyds-classic',
      idempotencyKey: 'pay-klarna-2026-11',
      balanceEffect: 'none',
    });
    expect(paidNov.occurrence.actualPaidMinor).toBe(7545);
    expect(paidNov.occurrence.bankDate).toBe('2026-11-05');
    expect(typeof paidNov.occurrence.recordedAt).toBe('string');
    expect(paidNov.obligation.nextDueDate).toBe('2026-12-05');

    // Retrying mark_obligation_paid with same parameters does not advance schedule twice or duplicate expenses
    const paidNovRetry = await callMcp('mark_obligation_paid', {
      obligationId: 'ob-emtb-klarna',
      yearMonth: '2026-11',
      paid: true,
      amountMajor: 75.45,
      bankDate: '2026-11-05',
      accountId: 'acc-lloyds-classic',
      idempotencyKey: 'pay-klarna-2026-11',
      balanceEffect: 'none',
    });
    expect(paidNovRetry.idempotentReplay).toBe(true);
    expect(paidNovRetry.obligation.nextDueDate).toBe('2026-12-05');

    // Update schedule so December 2026 has final £75.25 payment on 2026-12-05 and ends after December
    const schedRes = await callMcp('update_obligation_schedule', {
      obligationId: 'ob-emtb-klarna',
      endDate: '2026-12-05',
      finalAmountMajor: 75.25,
    });
    expect(schedRes.obligation.finalAmountMinor).toBe(7525);
    expect(schedRes.obligation.endDate).toBe('2026-12-05');

    // Verify November still reports £75.45 paid, December reports £75.25 due, and January reports £0 (closed after final payment)
    const novObs = await callMcp('list_upcoming_obligations', { yearMonth: '2026-11', scope: 'all' });
    const novKlarna = novObs.obligations.find((o: { id: string }) => o.id === 'ob-emtb-klarna');
    expect(novKlarna.isPaidThisMonth).toBe(true);
    expect(novKlarna.dueThisMonthMajor).toBeCloseTo(75.45, 2);

    const decObs = await callMcp('list_upcoming_obligations', { yearMonth: '2026-12', scope: 'all' });
    const decKlarna = decObs.obligations.find((o: { id: string }) => o.id === 'ob-emtb-klarna');
    expect(decKlarna.isPaidThisMonth).toBe(false);
    expect(decKlarna.dueThisMonthMajor).toBeCloseTo(75.25, 2);

    const janObs = await callMcp('list_upcoming_obligations', { yearMonth: '2027-01', scope: 'all' });
    const janKlarna = janObs.obligations.find((o: { id: string }) => o.id === 'ob-emtb-klarna');
    expect(janKlarna).toBeUndefined(); // Disappears from active obligations after endDate
    const janKlarnaArchived = janObs.archivedObligations.find((o: { id: string }) => o.id === 'ob-emtb-klarna');
    expect(janKlarnaArchived.dueThisMonthMajor).toBe(0);

    // Safe reconciliation batch: dry-run preview does not persist changes, atomic apply persists and is idempotent & reversible
    const dryBatch = await callMcp('reconcile_batch', {
      dryRun: true,
      snapshotMode: 'already_reflected_in_snapshot',
      transactions: [
        {
          accountId: 'acc-revolut-joint',
          merchant: 'Dry Run Coffee',
          amountMajor: 4.5,
          spentDate: '2026-11-06',
        },
      ],
    });
    expect(dryBatch.dryRun).toBe(true);
    expect(dryBatch.proposedChanges).toHaveLength(1);
    const txCheckAfterDry = await callMcp('list_transactions', {
      accountId: 'acc-revolut-joint',
      merchantQuery: 'Dry Run Coffee',
    });
    expect(txCheckAfterDry.total).toBe(0);

    // Apply batch for real, then reverse it
    const liveBatch = await callMcp('reconcile_batch', {
      dryRun: false,
      idempotencyKey: 'batch-test-1',
      snapshotMode: 'already_reflected_in_snapshot',
      transactions: [
        {
          accountId: 'acc-revolut-joint',
          merchant: 'Batch Bakery',
          amountMajor: 6.25,
          spentDate: '2026-11-06',
          idempotencyKey: 'tx-batch-bakery',
        },
      ],
    });
    expect(liveBatch.dryRun).toBe(false);
    expect(liveBatch.batchId).toBeTruthy();

    // Idempotent replay of the same batch
    const liveBatchReplay = await callMcp('reconcile_batch', {
      dryRun: false,
      idempotencyKey: 'batch-test-1',
      snapshotMode: 'already_reflected_in_snapshot',
      transactions: [
        {
          accountId: 'acc-revolut-joint',
          merchant: 'Batch Bakery',
          amountMajor: 6.25,
          spentDate: '2026-11-06',
          idempotencyKey: 'tx-batch-bakery',
        },
      ],
    });
    expect(liveBatchReplay.idempotentReplay).toBe(true);
    expect(liveBatchReplay.batchId).toBe(liveBatch.batchId);

    // Reverse the reconciliation batch
    const revRes = await callMcp('reverse_reconciliation_batch', { batchId: liveBatch.batchId });
    expect(revRes.reversed).toBe(true);
    const txCheckAfterRev = await callMcp('list_transactions', {
      accountId: 'acc-revolut-joint',
      merchantQuery: 'Batch Bakery',
    });
    expect(txCheckAfterRev.total).toBe(0);
  });

  it('supports multi-account salary distribution via POST /api/transfers/batch', async () => {
    const classicBefore = (
      await app.inject({ method: 'GET', url: '/api/accounts/acc-lloyds-classic', headers: { 'x-dev-user': 'wadera' } })
    ).json().account.balanceMinor as number;
    const clubBefore = (
      await app.inject({ method: 'GET', url: '/api/accounts/acc-lloyds-club', headers: { 'x-dev-user': 'wadera' } })
    ).json().account.balanceMinor as number;
    const saverBefore = (
      await app.inject({ method: 'GET', url: '/api/accounts/acc-lloyds-saver', headers: { 'x-dev-user': 'wadera' } })
    ).json().account.balanceMinor as number;

    const batchRes = await app.inject({
      method: 'POST',
      url: '/api/transfers/batch',
      headers: { 'x-dev-user': 'wadera' },
      payload: {
        sourceAccountId: 'acc-lloyds-classic',
        transferDate: '2026-11-07',
        description: 'Monthly salary distribution',
        allocations: [
          { destinationAccountId: 'acc-lloyds-club', amountMajor: 100.0 },
          { destinationAccountId: 'acc-lloyds-saver', amountMajor: 50.0 },
        ],
      },
    });
    expect(batchRes.statusCode).toBe(200);
    const data = batchRes.json();
    expect(data.ok).toBe(true);
    expect(data.totalDeductedMinor).toBe(15000);
    expect(data.fromAccountAfterMinor).toBe(classicBefore - 15000);

    const clubAfter = (
      await app.inject({ method: 'GET', url: '/api/accounts/acc-lloyds-club', headers: { 'x-dev-user': 'wadera' } })
    ).json().account.balanceMinor as number;
    const saverAfter = (
      await app.inject({ method: 'GET', url: '/api/accounts/acc-lloyds-saver', headers: { 'x-dev-user': 'wadera' } })
    ).json().account.balanceMinor as number;
    expect(clubAfter).toBe(clubBefore + 10000);
    expect(saverAfter).toBe(saverBefore + 5000);
  });
});
