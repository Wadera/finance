import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildRateMap, convertMinor } from '../shared/currency.js';
import {
  addMonthsToDate,
  applyObligationPaymentReset,
  buildPotRollupTree,
  cadenceIntervalMonths,
  computeMonthlyIncomeMinor,
  computeObligationMonthMetrics,
  projectWealthHorizon,
  reconstructWealthHistory,
  resolveWaderaShareBp,
} from '../shared/financeEngine.js';
import type {
  CurrencyCode,
  LocaleCode,
  PartnerVisibility,
  SplitMode,
  WorkspaceKind,
  WorkspaceRole,
} from '../shared/types.js';
import { type AuthConfig, requireUser } from './auth.js';
import type { FinanceStore } from './db.js';

function prevYearMonths(centerYm: string, count: number): string[] {
  const [y, m] = centerYm.split('-').map(Number);
  const res: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const total = y * 12 + (m - 1) - i;
    const yy = Math.floor(total / 12);
    const mm = (total % 12) + 1;
    res.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return res;
}

function shiftYearMonth(ym: string, deltaMonths: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + deltaMonths;
  const yy = Math.floor(total / 12);
  const mm = ((total % 12) + 12) % 12 + 1;
  return `${yy}-${String(mm).padStart(2, '0')}`;
}

function adjustAccountBalance(
  store: FinanceStore,
  accountId: string | null | undefined,
  deltaTxMinor: number,
  txCurrency: CurrencyCode
): void {
  if (!accountId || !Number.isFinite(deltaTxMinor) || deltaTxMinor === 0) return;
  const acc = store.db
    .prepare(`SELECT id, currency, balance_minor FROM accounts WHERE id = ?`)
    .get(accountId) as { id: string; currency: CurrencyCode; balance_minor: number } | undefined;
  if (!acc) return;
  const rateMap = buildRateMap(store.getFxRates());
  const deltaAccMinor =
    acc.currency === txCurrency
      ? Math.round(deltaTxMinor)
      : convertMinor(Math.abs(Math.round(deltaTxMinor)), txCurrency, acc.currency, rateMap) *
        (deltaTxMinor < 0 ? -1 : 1);
  store.db
    .prepare(`UPDATE accounts SET balance_minor = balance_minor + ?, updated_at = ? WHERE id = ?`)
    .run(deltaAccMinor, new Date().toISOString(), acc.id);
}

function applyLiabilityPaydown(
  store: FinanceStore,
  liabilityId: string | null | undefined,
  paymentMinor: number,
  paymentCurrency: CurrencyCode,
  isScheduledInstallment: boolean
): number {
  if (!liabilityId || !Number.isFinite(paymentMinor) || paymentMinor <= 0) return 0;
  const liab = store.db
    .prepare(`SELECT id, currency, balance_minor, apr_bp FROM liabilities WHERE id = ?`)
    .get(liabilityId) as
    | { id: string; currency: CurrencyCode; balance_minor: number; apr_bp: number }
    | undefined;
  if (!liab) return 0;
  const rateMap = buildRateMap(store.getFxRates());
  const payInLiabCur =
    liab.currency === paymentCurrency
      ? Math.round(paymentMinor)
      : convertMinor(Math.round(paymentMinor), paymentCurrency, liab.currency, rateMap);

  let principalReduction = payInLiabCur;
  if (isScheduledInstallment && liab.apr_bp > 0 && liab.balance_minor > 0) {
    const monthlyInterestMinor = Math.round((liab.balance_minor * (liab.apr_bp / 10000)) / 12);
    if (payInLiabCur > monthlyInterestMinor) {
      principalReduction = payInLiabCur - monthlyInterestMinor;
    }
  }
  const actualDelta = Math.min(liab.balance_minor, Math.max(0, principalReduction));
  if (actualDelta > 0) {
    store.db
      .prepare(`UPDATE liabilities SET balance_minor = MAX(0, balance_minor - ?), updated_at = ? WHERE id = ?`)
      .run(actualDelta, new Date().toISOString(), liab.id);
  }
  return actualDelta;
}

function reverseLiabilityPaydown(
  store: FinanceStore,
  liabilityId: string | null | undefined,
  deltaNativeMinor: number
): void {
  if (!liabilityId || !Number.isFinite(deltaNativeMinor) || deltaNativeMinor <= 0) return;
  store.db
    .prepare(`UPDATE liabilities SET balance_minor = balance_minor + ?, updated_at = ? WHERE id = ?`)
    .run(Math.round(deltaNativeMinor), new Date().toISOString(), liabilityId);
}

function defaultAccountForWorkspace(
  store: FinanceStore,
  workspaceId: string,
  preferredCurrency?: CurrencyCode
): string | null {
  const rows = store.listAccounts([workspaceId]);
  if (!rows.length) return null;
  if (preferredCurrency) {
    const match =
      rows.find((a) => a.currency === preferredCurrency && a.isPrimaryRunway) ||
      rows.find((a) => a.currency === preferredCurrency);
    if (match) return match.id;
  }
  const primary = rows.find((a) => a.isPrimaryRunway);
  return (primary || rows[0]).id;
}

export function registerApiRoutes(app: FastifyInstance, store: FinanceStore, cfg: AuthConfig): void {
  // Healthcheck (no private data exposed)
  app.get('/healthz', async () => {
    const row = store.db.prepare('SELECT 1 AS ok').get() as { ok: number };
    return { status: row?.ok === 1 ? 'ok' : 'degraded', service: 'skyday-finance' };
  });

  // Bootstrap metadata
  app.get('/api/bootstrap', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;

    const workspaces = store
      .getWorkspaces()
      .filter(
        (ws) =>
          store.canIncludeInCombinedWealth(user.id, ws.id) ||
          (ws.kind === 'personal' &&
            (user.id === 'usr-wadera' || user.id === 'usr-walter') &&
            (ws.ownerUserId === 'usr-wadera' || ws.ownerUserId === 'usr-walter'))
      )
      .map((ws) => ({
        ...ws,
        role: store.getEffectiveWorkspaceRole(user.id, ws.id),
        canReadItems: store.canReadWorkspaceItems(user.id, ws.id),
        canWrite: store.canWriteWorkspace(user.id, ws.id),
        canManage: store.canManageWorkspace(user.id, ws.id),
        includedInFamilyWealth: store.canIncludeInCombinedWealth(user.id, ws.id),
        members: store.canReadWorkspaceItems(user.id, ws.id) ? store.listWorkspaceMembers(ws.id) : [],
      }));

    const allUsers = store.getUsers();
    return {
      user,
      users: (user.isAdmin ? allUsers : allUsers.filter((u) => u.isActive)).map((u) => ({
        id: u.id,
        handle: u.handle,
        displayName: u.displayName,
        email: user.isAdmin || u.id === user.id ? u.email : undefined,
        personalWorkspaceId: u.personalWorkspaceId,
        authProvider: u.authProvider,
        defaultCurrency: u.defaultCurrency,
        locale: u.locale,
        isAdmin: u.isAdmin,
        isActive: u.isActive,
      })),
      workspaces,
      fxRates: store.getFxRates(),
      apiKeys: store.listApiKeys(user.id),
    };
  });

  // Monthly Budget, Sinking-Fund 'Preserve', Pot Roll-Up, Timeline Runway & Sankey Analytics
  app.get('/api/budget/month', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;

    const q = (req.query || {}) as { ym?: string; scope?: string; horizon?: string };
    const ym = q.ym && /^\d{4}-\d{2}$/.test(q.ym) ? q.ym : new Date().toISOString().slice(0, 7);
    const scope = q.scope || 'all';
    const rawHorizon = Number(q.horizon || 1);
    const horizonMonths = ([1, 3, 6, 12, 60, 120].includes(rawHorizon) ? rawHorizon : 1) as 1 | 3 | 6 | 12 | 60 | 120;
    const cur = user.defaultCurrency;
    const fxRates = store.getFxRates();
    const rateMap = buildRateMap(fxRates);

    const wsIds = store.readableWorkspaceIds(user.id, scope);
    const allReadableWsIds = store.readableWorkspaceIds(user.id, 'all');
    const allAccounts = store.listAccounts(allReadableWsIds);
    const accById = new Map(allAccounts.map((a) => [a.id, a]));
    const allLiabilities = store.listLiabilities(allReadableWsIds);
    const liabById = new Map(allLiabilities.map((l) => [l.id, l]));
    const accounts = store.listAccounts(wsIds);
    const incomes = store.listIncomes(wsIds);
    const pots = store.listPots(wsIds);
    const obligations = store.listObligations(wsIds);
    const occurrences = store.listPaymentOccurrences(
      ym,
      obligations.map((o) => o.id)
    );
    const occByOb = new Map(occurrences.map((o) => [o.obligationId, o]));

    const sixMonths = prevYearMonths(ym, 6);
    const allSixMonthExpenses = store.listExpenses(wsIds, sixMonths[0], sixMonths[sixMonths.length - 1]);
    const expenses = allSixMonthExpenses
      .filter((e) => e.spentDate.slice(0, 7) === ym)
      .map((e) => ({
        ...e,
        accountId: e.accountId ?? null,
        accountName: e.accountId ? (accById.get(e.accountId)?.name ?? null) : null,
        liabilityId: e.liabilityId ?? null,
        liabilityName: e.liabilityId ? (liabById.get(e.liabilityId)?.name ?? null) : null,
        flowDirection: e.flowDirection === 'inflow' ? ('inflow' as const) : ('outflow' as const),
        displayAmountMinor: convertMinor(e.amountMinor, e.currency, cur, rateMap),
      }));
    const outflowExpenses = expenses.filter((e) => e.flowDirection !== 'inflow');

    // Compute Wadera & Walter monthly incomes for proportional split calculations
    const waderaIncs = store.listIncomes(['ws-wadera']);
    const walterIncs = store.listIncomes(['ws-walter']);
    const waderaIncGbp = waderaIncs.reduce((s, i) => s + computeMonthlyIncomeMinor(i, ym, 'GBP', rateMap), 0);
    const walterIncGbp = walterIncs.reduce((s, i) => s + computeMonthlyIncomeMinor(i, ym, 'GBP', rateMap), 0);

    const enrichedObligations = obligations.map((ob) => {
      const metrics = computeObligationMonthMetrics(ob, ym);
      const occ = occByOb.get(ob.id) ?? null;
      const isPaidThisMonth = occ?.status === 'paid';
      const waderaBp =
        ob.workspaceId === 'ws-home'
          ? resolveWaderaShareBp(ob.splitMode, ob.waderaSplitBp, waderaIncGbp, walterIncGbp)
          : ob.workspaceId === 'ws-wadera'
          ? 10000
          : 0;
      const userShareBp = user.handle === 'wadera' ? waderaBp : 10000 - waderaBp;

      const dueDisplayMinor = convertMinor(metrics.dueThisMonthNativeMinor, ob.currency, cur, rateMap);
      const effectivePreserveNativeMinor =
        !metrics.isDueThisMonth && isPaidThisMonth && occ?.actualPaidMinor != null
          ? occ.actualPaidMinor
          : metrics.monthlyPreserveNativeMinor;
      const effectiveBurdenNativeMinor =
        !metrics.isDueThisMonth && isPaidThisMonth && occ?.actualPaidMinor != null
          ? occ.actualPaidMinor
          : metrics.effectiveMonthlyBurdenNativeMinor;
      const preserveDisplayMinor = convertMinor(effectivePreserveNativeMinor, ob.currency, cur, rateMap);
      const effectiveDisplayMinor = convertMinor(effectiveBurdenNativeMinor, ob.currency, cur, rateMap);
      const targetDisplayMinor = convertMinor(ob.amountMinor, ob.currency, cur, rateMap);
      const preservedDisplayMinor = convertMinor(ob.preservedMinor, ob.currency, cur, rateMap);
      const resolvedAccId = (occ?.accountId ?? ob.accountId) || null;
      const resolvedLiabId = (occ?.liabilityId ?? ob.liabilityId) || null;

      return {
        ...ob,
        accountId: ob.accountId ?? null,
        accountName: resolvedAccId ? (accById.get(resolvedAccId)?.name ?? null) : null,
        liabilityId: ob.liabilityId ?? null,
        liabilityName: resolvedLiabId ? (liabById.get(resolvedLiabId)?.name ?? null) : null,
        metrics: {
          ...metrics,
          monthlyPreserveNativeMinor: effectivePreserveNativeMinor,
          effectiveMonthlyBurdenNativeMinor: effectiveBurdenNativeMinor,
        },
        occurrence: occ,
        isPaidThisMonth,
        userShareBp,
        dueDisplayMinor,
        preserveDisplayMinor,
        effectiveDisplayMinor,
        targetDisplayMinor,
        preservedDisplayMinor,
      };
    });

    const potTree = buildPotRollupTree(pots, obligations, outflowExpenses, ym, cur, rateMap);

    // Monthly Income streams + explicit arrival tracking (income_occurrences)
    const incomeOccurrences = store.listIncomeOccurrences(
      ym,
      incomes.map((i) => i.id)
    );
    const incOccById = new Map(incomeOccurrences.map((io) => [io.incomeId, io]));

    const activeIncomes = incomes
      .map((inc) => {
        const monthlyDisplayMinor = computeMonthlyIncomeMinor(inc, ym, cur, rateMap);
        const occ = incOccById.get(inc.id) ?? null;
        const expectedDate = `${ym}-${String(Math.min(28, Math.max(1, inc.paydayDay))).padStart(2, '0')}`;
        const resolvedAccId = (occ?.accountId ?? inc.accountId) || null;
        return {
          ...inc,
          accountId: inc.accountId ?? null,
          accountName: resolvedAccId ? (accById.get(resolvedAccId)?.name ?? null) : null,
          monthlyDisplayMinor,
          expectedDate,
          isReceivedThisMonth: Boolean(occ && occ.status === 'received'),
          receivedAt: occ?.receivedAt ?? null,
        };
      })
      .filter((i) => i.monthlyDisplayMinor > 0);

    const totalIncomeMinor = activeIncomes.reduce((s, i) => s + i.monthlyDisplayMinor, 0);

    // Unassigned obligations/expenses (where potId is null)
    const unassignedExpensesMinor = outflowExpenses
      .filter((e) => !e.potId)
      .reduce((s, e) => s + convertMinor(e.amountMinor, e.currency, cur, rateMap), 0);
    const unassignedObMinor = enrichedObligations
      .filter((o) => !o.potId)
      .reduce((s, o) => s + o.effectiveDisplayMinor, 0);

    const potPlannedTotalMinor =
      potTree.reduce((s, n) => s + n.effectiveTotalDisplayMinor, 0) + unassignedExpensesMinor + unassignedObMinor;

    const totalPreserveSliceMinor = enrichedObligations
      .filter((o) => !o.metrics.isDueThisMonth && o.preserveDisplayMinor > 0)
      .reduce((s, o) => s + o.preserveDisplayMinor, 0);

    const netMonthlySurplusMinor = totalIncomeMinor - potPlannedTotalMinor;

    // Smart Payday-Bridge Cashflow Calculation:
    // - Most bills are scheduled around the 1st–25th, while salary arrives around the 27th.
    // - Therefore this month's spending (1st–26th) is funded by Previous Month Overflow (from last month's 27th salary),
    //   while this month's 27th salary (dotted until ticked received on Timeline) is bridged to fund Next Month's pre-salary bills!
    const prevYm = shiftYearMonth(ym, -1);
    const nextYm = shiftYearMonth(ym, 1);
    const primaryPaydayDay =
      activeIncomes.length > 0 ? Math.max(...activeIncomes.map((i) => i.paydayDay)) : 27;

    // 1. Previous Month Overflow (from previous cycle's late-month salary minus any post-payday bills in prevYm)
    const prevCycleSalaryMinor = incomes.reduce((sum, inc) => {
      if (!inc.isActive || inc.paydayDay < 12) return sum;
      const inPrev = computeMonthlyIncomeMinor(inc, prevYm, cur, rateMap);
      const fallbackCur = inPrev > 0 ? inPrev : computeMonthlyIncomeMinor(inc, ym, cur, rateMap);
      return sum + fallbackCur;
    }, 0);

    const prevPostPaydayObMinor = obligations
      .filter((o) => o.isActive && o.dueDay > primaryPaydayDay)
      .reduce((sum, ob) => {
        const m = computeObligationMonthMetrics(ob, prevYm);
        return sum + convertMinor(m.effectiveMonthlyBurdenNativeMinor, ob.currency, cur, rateMap);
      }, 0);

    const earlyMonthReceivedMinor = activeIncomes
      .filter((i) => i.paydayDay < 12 && i.isReceivedThisMonth)
      .reduce((s, i) => s + i.monthlyDisplayMinor, 0);

    const overflowInMinor = Math.max(
      0,
      (prevCycleSalaryMinor > 0 ? prevCycleSalaryMinor - prevPostPaydayObMinor : 0) + earlyMonthReceivedMinor
    );

    const thisMonthBufferMinor = Math.max(0, overflowInMinor - potPlannedTotalMinor);
    const thisMonthShortfallMinor = Math.max(0, potPlannedTotalMinor - overflowInMinor);

    // 2. Next Month Needed Before Next Salary (1st .. primaryPaydayDay - 1 of nextYm)
    const nextMonthPreSalaryObligations = obligations.filter(
      (ob) => ob.isActive && (ob.dueDay < primaryPaydayDay || ob.cadence !== 'monthly')
    );
    const nextMonthPotTree = buildPotRollupTree(
      pots,
      nextMonthPreSalaryObligations,
      [],
      nextYm,
      cur,
      rateMap
    );
    const nextMonthUnassignedObMinor = nextMonthPreSalaryObligations
      .filter((o) => !o.potId)
      .reduce((sum, ob) => {
        const m = computeObligationMonthMetrics(ob, nextYm);
        return sum + convertMinor(m.effectiveMonthlyBurdenNativeMinor, ob.currency, cur, rateMap);
      }, 0);

    const nextMonthPreSalaryMinor =
      nextMonthPotTree.reduce((s, n) => s + n.effectiveTotalDisplayMinor, 0) + nextMonthUnassignedObMinor;

    const nextMonthBreakdown = [
      ...nextMonthPotTree
        .filter((n) => n.effectiveTotalDisplayMinor > 0)
        .map((n) => ({
          id: `next-pot-${n.pot.id}`,
          potId: n.pot.id,
          name: n.pot.name,
          color: n.pot.color || '#DC2626',
          displayMinor: n.effectiveTotalDisplayMinor,
        })),
      ...(nextMonthUnassignedObMinor > 0
        ? [
            {
              id: 'next-pot-other',
              potId: null,
              name: 'Other Pre-Salary Bills',
              color: '#DC2626',
              displayMinor: nextMonthUnassignedObMinor,
            },
          ]
        : []),
    ];

    const upcomingCycleIncomes = activeIncomes.filter((i) => i.paydayDay >= 12 || !i.isReceivedThisMonth);
    const upcomingSalaryTotalMinor = upcomingCycleIncomes.reduce((s, i) => s + i.monthlyDisplayMinor, 0);
    const upcomingSalaryReceivedMinor = upcomingCycleIncomes
      .filter((i) => i.isReceivedThisMonth)
      .reduce((s, i) => s + i.monthlyDisplayMinor, 0);
    const upcomingSalaryPendingMinor = upcomingSalaryTotalMinor - upcomingSalaryReceivedMinor;
    const projectedFreeFromUpcomingMinor = Math.max(0, upcomingSalaryTotalMinor - nextMonthPreSalaryMinor);

    // Account Runway & Month-End Sufficiency Engine
    // Honest pre-salary sufficiency: unticked future salary is NOT counted as available cash before payday!
    const [yrNum, moNum] = ym.split('-').map(Number);
    const daysInMonth = new Date(yrNum, moNum, 0).getDate();
    const todayIso = new Date().toISOString().slice(0, 10);
    const currentDay = todayIso.slice(0, 7) === ym ? Number(todayIso.slice(8, 10)) : 1;

    const runwayCashMinor = accounts
      .filter((a) => a.isPrimaryRunway)
      .reduce((s, a) => s + convertMinor(a.balanceMinor, a.currency, cur, rateMap), 0);

    const unpaidBillsMinor = enrichedObligations
      .filter((o) => o.metrics.isDueThisMonth && !o.isPaidThisMonth)
      .reduce((s, o) => s + o.dueDisplayMinor, 0);

    const unpaidPrePaydayBillsMinor = enrichedObligations
      .filter((o) => o.metrics.isDueThisMonth && !o.isPaidThisMonth && o.dueDay < primaryPaydayDay)
      .reduce((s, o) => s + o.dueDisplayMinor, 0);

    // Only count unticked incomes as future expected inflow AFTER their paydayDay
    const remainingPaydaysIncomeMinor = activeIncomes
      .filter((i) => !i.isReceivedThisMonth)
      .reduce((s, i) => s + i.monthlyDisplayMinor, 0);

    const unallocatedEnvelopeRemainingMinor = potTree.reduce((s, n) => {
      const sumEnv = (node: (typeof potTree)[number]): number =>
        node.unallocatedEnvelopeDisplayMinor + node.children.reduce((acc, c) => acc + sumEnv(c), 0);
      return s + sumEnv(n);
    }, 0);

    const unpaidPreserveSliceMinor = enrichedObligations
      .filter((o) => !o.metrics.isDueThisMonth && !o.isPaidThisMonth && o.preserveDisplayMinor > 0)
      .reduce((s, o) => s + o.preserveDisplayMinor, 0);

    const totalNeededBeforePaydayMinor = unpaidPrePaydayBillsMinor + unallocatedEnvelopeRemainingMinor;
    const prePaydayBufferMinor = runwayCashMinor - totalNeededBeforePaydayMinor;

    const totalNeededTillMonthEndMinor =
      unpaidBillsMinor + unpaidPreserveSliceMinor + unallocatedEnvelopeRemainingMinor;
    // Available now without relying on unticked salary:
    const currentCashAfterMonthBillsMinor = runwayCashMinor - totalNeededTillMonthEndMinor;
    // Projected after unticked payday arrives (before reserving next month's pre-salary bills):
    const projectedEndBalanceMinor =
      runwayCashMinor + remainingPaydaysIncomeMinor - totalNeededTillMonthEndMinor;
    // True cycle buffer after ALSO reserving next month's pre-salary requirements from the new salary:
    const projectedAfterNextMonthReserveMinor =
      projectedEndBalanceMinor - nextMonthPreSalaryMinor;
    const shortfallMinor = Math.max(0, -prePaydayBufferMinor);

    // Unified Chronological Ledger of all Month Expenses + Completed Checklist Payments (with Timestamps)
    const potById = new Map(pots.map((p) => [p.id, p]));
    const timelineLedger: Array<{
      id: string;
      kind: 'expense' | 'paid_bill' | 'sinking_set_aside';
      flowDirection: 'outflow' | 'inflow';
      entityType: 'expense' | 'obligation';
      entityId: string;
      occurrenceId?: string;
      workspaceId: string;
      accountId: string | null;
      accountName: string | null;
      potId: string | null;
      potName: string | null;
      potColor: string;
      title: string;
      subtitle: string;
      date: string;
      timestamp: string;
      day: number;
      amountMinor: number;
      currency: CurrencyCode;
      displayAmountMinor: number;
    }> = [];

    for (const exp of expenses) {
      const timePart =
        exp.createdAt && exp.createdAt.length >= 16 && /^\d{2}:\d{2}/.test(exp.createdAt.slice(11, 16))
          ? exp.createdAt.slice(11, 16)
          : '12:00';
      const timestamp = `${exp.spentDate}T${timePart}:00Z`;
      const day = Math.min(daysInMonth, Math.max(1, Number(exp.spentDate.slice(8, 10)) || 1));
      const pot = exp.potId ? potById.get(exp.potId) : undefined;
      timelineLedger.push({
        id: `led-exp-${exp.id}`,
        kind: 'expense',
        flowDirection: exp.flowDirection === 'inflow' ? 'inflow' : 'outflow',
        entityType: 'expense',
        entityId: exp.id,
        workspaceId: exp.workspaceId,
        accountId: exp.accountId ?? null,
        accountName: exp.accountName ?? null,
        potId: exp.potId,
        potName: pot?.name ?? null,
        potColor: pot?.color ?? (exp.flowDirection === 'inflow' ? '#10B981' : '#E11D48'),
        title: exp.merchant,
        subtitle: exp.description || '',
        date: exp.spentDate,
        timestamp,
        day,
        amountMinor: exp.amountMinor,
        currency: exp.currency,
        displayAmountMinor: exp.displayAmountMinor,
      });
    }

    for (const ob of enrichedObligations) {
      if (!ob.isPaidThisMonth || !ob.occurrence) continue;
      const occ = ob.occurrence;
      const fallbackDate = `${ym}-${String(Math.min(daysInMonth, Math.max(1, ob.dueDay || 1))).padStart(2, '0')}`;
      const eventDate =
        occ.paidAt && occ.paidAt.slice(0, 7) === ym
          ? occ.paidAt.slice(0, 10)
          : occ.dueDate && occ.dueDate.slice(0, 7) === ym
          ? occ.dueDate.slice(0, 10)
          : fallbackDate;
      const timePart =
        occ.paidAt && occ.paidAt.length >= 16 && /^\d{2}:\d{2}/.test(occ.paidAt.slice(11, 16))
          ? occ.paidAt.slice(11, 16)
          : '09:00';
      const timestamp = `${eventDate}T${timePart}:00Z`;
      const day = Math.min(daysInMonth, Math.max(1, Number(eventDate.slice(8, 10)) || ob.dueDay || 1));
      const actualNativeMinor =
        occ.actualPaidMinor ??
        (ob.metrics.isDueThisMonth ? ob.amountMinor : ob.metrics.monthlyPreserveNativeMinor || ob.amountMinor);
      const displayAmountMinor = convertMinor(actualNativeMinor, ob.currency, cur, rateMap);
      const pot = ob.potId ? potById.get(ob.potId) : undefined;
      const effAccId = (occ.accountId ?? ob.accountId) || null;
      timelineLedger.push({
        id: `led-occ-${occ.id}`,
        kind: ob.metrics.isDueThisMonth ? 'paid_bill' : 'sinking_set_aside',
        flowDirection: 'outflow',
        entityType: 'obligation',
        entityId: ob.id,
        occurrenceId: occ.id,
        workspaceId: ob.workspaceId,
        accountId: effAccId,
        accountName: effAccId ? (accById.get(effAccId)?.name ?? null) : null,
        potId: ob.potId,
        potName: pot?.name ?? null,
        potColor: pot?.color ?? '#059669',
        title: ob.name,
        subtitle: ob.metrics.isDueThisMonth ? ob.cadence : `Preserve (${ob.nextDueDate})`,
        date: eventDate,
        timestamp,
        day,
        amountMinor: actualNativeMinor,
        currency: ob.currency,
        displayAmountMinor,
      });
    }

    timelineLedger.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));

    // Daily Runway Curve (days 1..daysInMonth) plotting ALL expenses, completed checklist items, upcoming bills & salary
    const completedOutflowsThisMonthMinor = timelineLedger.reduce(
      (s, e) => s + (e.flowDirection === 'inflow' ? -e.displayAmountMinor : e.displayAmountMinor),
      0
    );
    const receivedIncomesThisMonthMinor = activeIncomes
      .filter((i) => i.isReceivedThisMonth)
      .reduce((s, i) => s + i.monthlyDisplayMinor, 0);
    const startOfMonthCashMinor =
      runwayCashMinor + completedOutflowsThisMonthMinor - receivedIncomesThisMonthMinor;

    const dailyCurve: Array<{
      day: number;
      date: string;
      balanceMinor: number;
      label?: string;
      events: Array<{
        id: string;
        kind: 'expense' | 'paid_bill' | 'sinking_set_aside' | 'unpaid_bill' | 'income';
        title: string;
        timestamp?: string;
        displayMinor: number;
      }>;
    }> = [];

    let runningBal = startOfMonthCashMinor;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${ym}-${String(d).padStart(2, '0')}`;
      const dayEvents: (typeof dailyCurve)[number]['events'] = [];

      // 1. Income arrivals (received or expected on paydayDay)
      for (const inc of activeIncomes) {
        const incDay =
          inc.isReceivedThisMonth && inc.receivedAt && inc.receivedAt.slice(0, 7) === ym
            ? Math.min(daysInMonth, Math.max(1, Number(inc.receivedAt.slice(8, 10)) || inc.paydayDay))
            : Math.min(daysInMonth, Math.max(1, inc.paydayDay));
        if (incDay === d) {
          runningBal += inc.monthlyDisplayMinor;
          dayEvents.push({
            id: inc.id,
            kind: 'income',
            title: inc.isReceivedThisMonth ? `${inc.name} ✓` : `${inc.name} (expected)`,
            timestamp: inc.receivedAt || inc.expectedDate,
            displayMinor: inc.monthlyDisplayMinor,
          });
        }
      }

      // 2. Logged expenses, deposits & completed checklist items on day d
      for (const entry of timelineLedger) {
        if (entry.day === d) {
          if (entry.flowDirection === 'inflow') {
            runningBal += entry.displayAmountMinor;
            dayEvents.push({
              id: entry.id,
              kind: 'income',
              title: entry.title,
              timestamp: entry.timestamp,
              displayMinor: entry.displayAmountMinor,
            });
          } else {
            runningBal -= entry.displayAmountMinor;
            dayEvents.push({
              id: entry.id,
              kind: entry.kind,
              title: entry.title,
              timestamp: entry.timestamp,
              displayMinor: entry.displayAmountMinor,
            });
          }
        }
      }

      // 3. Remaining unpaid scheduled obligations & unpaid monthly sinking set-asides
      for (const ob of enrichedObligations) {
        if (ob.isPaidThisMonth) continue;
        const obDay = Math.min(daysInMonth, Math.max(1, ob.dueDay || 1));
        if (ob.metrics.isDueThisMonth && obDay === d) {
          runningBal -= ob.dueDisplayMinor;
          dayEvents.push({
            id: ob.id,
            kind: 'unpaid_bill',
            title: ob.name,
            displayMinor: ob.dueDisplayMinor,
          });
        } else if (!ob.metrics.isDueThisMonth && ob.preserveDisplayMinor > 0 && obDay === d) {
          runningBal -= ob.preserveDisplayMinor;
          dayEvents.push({
            id: ob.id,
            kind: 'unpaid_bill',
            title: `${ob.name} (Preserve)`,
            displayMinor: ob.preserveDisplayMinor,
          });
        }
      }

      const labels = dayEvents.map((ev) => `${ev.kind === 'income' ? '+' : '-'}${ev.title}`);
      dailyCurve.push({
        day: d,
        date: dateStr,
        balanceMinor: runningBal,
        label: labels.length ? labels.join(', ') : undefined,
        events: dayEvents,
      });
    }

    // Sankey Diagram Data (Income -> Workspace Pool -> Top-Level Pots + Preserve + Net Surplus)
    const sankeyNodes: Array<{ id: string; name: string; stage: number; color: string }> = [];
    const sankeyLinks: Array<{ source: string; target: string; valueMinor: number }> = [];

    if (totalIncomeMinor > 0 || potPlannedTotalMinor > 0) {
      const poolId = 'pool-budget';
      sankeyNodes.push({ id: poolId, name: 'Monthly Pool', stage: 1, color: '#334155' });

      for (const inc of activeIncomes) {
        const nid = `inc-${inc.id}`;
        sankeyNodes.push({
          id: nid,
          name: inc.name,
          stage: 0,
          color: inc.workspaceId === 'ws-wadera' ? '#2E6F7E' : '#4E8C6B',
        });
        sankeyLinks.push({ source: nid, target: poolId, valueMinor: inc.monthlyDisplayMinor });
      }

      if (totalIncomeMinor < potPlannedTotalMinor) {
        sankeyNodes.push({ id: 'inc-drawdown', name: 'Account Drawdown', stage: 0, color: '#D97706' });
        sankeyLinks.push({
          source: 'inc-drawdown',
          target: poolId,
          valueMinor: potPlannedTotalMinor - totalIncomeMinor,
        });
      }

      for (const rootNode of potTree) {
        if (rootNode.effectiveTotalDisplayMinor <= 0) continue;
        const pid = `pot-${rootNode.pot.id}`;
        sankeyNodes.push({
          id: pid,
          name: rootNode.pot.name,
          stage: 2,
          color: rootNode.pot.color || '#2E6F7E',
        });
        sankeyLinks.push({
          source: poolId,
          target: pid,
          valueMinor: rootNode.effectiveTotalDisplayMinor,
        });
      }

      if (unassignedExpensesMinor + unassignedObMinor > 0) {
        sankeyNodes.push({ id: 'pot-other', name: 'Other Spend', stage: 2, color: '#64748B' });
        sankeyLinks.push({
          source: poolId,
          target: 'pot-other',
          valueMinor: unassignedExpensesMinor + unassignedObMinor,
        });
      }

      if (netMonthlySurplusMinor > 0) {
        sankeyNodes.push({ id: 'out-surplus', name: 'Unallocated Savings', stage: 2, color: '#10B981' });
        sankeyLinks.push({
          source: poolId,
          target: 'out-surplus',
          valueMinor: netMonthlySurplusMinor,
        });
      }
    }

    // Multi-Period Historical & Trajectory Engine (1M / 3M / 6M / 12M / 5Y / 10Y)
    const chartMonthsCount = horizonMonths === 1 ? 6 : horizonMonths;
    const historyMonths = prevYearMonths(ym, chartMonthsCount);
    const allHistoryExpenses =
      chartMonthsCount <= 6
        ? allSixMonthExpenses
        : store.listExpenses(wsIds, historyMonths[0], historyMonths[historyMonths.length - 1]);

    const expsByYm = new Map<string, typeof allHistoryExpenses>();
    for (const e of allHistoryExpenses) {
      if (e.flowDirection === 'inflow') continue;
      const k = e.spentDate.slice(0, 7);
      const arr = expsByYm.get(k);
      if (arr) arr.push(e);
      else expsByYm.set(k, [e]);
    }

    const monthlySeries = historyMonths.map((mKey) => {
      const mInc = incomes.reduce((s, i) => s + computeMonthlyIncomeMinor(i, mKey, cur, rateMap), 0);
      const mExps = expsByYm.get(mKey) ?? [];
      // Filter obligations that existed in mKey (e.g. UK house mortgage started 2022-09)
      const activeHistObs = obligations.filter((o) => {
        if (mKey < '2022-09' && o.id === 'ob-mortgage') return false;
        return true;
      });
      const mTree = buildPotRollupTree(pots, activeHistObs, mExps, mKey, cur, rateMap);
      let mSpend =
        mTree.reduce((s, n) => s + n.effectiveTotalDisplayMinor, 0) +
        mExps.filter((e) => !e.potId).reduce((s, e) => s + convertMinor(e.amountMinor, e.currency, cur, rateMap), 0);

      // For earlier historical years (>6 months ago) with no itemized receipts yet, scale baseline living costs proportionally to active salary band
      if (mExps.length === 0 && mKey < sixMonths[0] && mInc > 0) {
        const baselineLivingMinor = Math.round(mInc * 0.64);
        mSpend = Math.min(mSpend > 0 ? mSpend : baselineLivingMinor, Math.max(baselineLivingMinor, Math.round(mInc * 0.72)));
      } else if (mInc === 0 && mExps.length === 0 && mKey < sixMonths[0]) {
        mSpend = 0;
      }

      const savedMinor = mInc - mSpend;
      return {
        yearMonth: mKey,
        incomeMinor: mInc,
        spendMinor: mSpend,
        savedMinor,
      };
    });

    const trend6m = monthlySeries.slice(-6).map((m) => ({
      yearMonth: m.yearMonth,
      incomeMinor: m.incomeMinor,
      spendMinor: m.spendMinor,
      savedMinor: Math.max(0, m.savedMinor),
    }));

    // Build aggregated chart buckets for the selected zoom horizon (monthly for <=12M, quarterly for 5Y, yearly for 10Y)
    const rawBuckets: Array<{
      key: string;
      label: string;
      subLabel: string;
      incomeMinor: number;
      spendMinor: number;
      savedMinor: number;
    }> = [];

    if (chartMonthsCount <= 12) {
      for (const m of monthlySeries) {
        rawBuckets.push({
          key: m.yearMonth,
          label: chartMonthsCount <= 6 ? m.yearMonth.slice(5) : `${m.yearMonth.slice(5)}/${m.yearMonth.slice(2, 4)}`,
          subLabel: m.yearMonth,
          incomeMinor: m.incomeMinor,
          spendMinor: m.spendMinor,
          savedMinor: m.savedMinor,
        });
      }
    } else if (chartMonthsCount <= 60) {
      // Group 60 months (5Y) into 3-month quarters (20 bars)
      for (let i = 0; i < monthlySeries.length; i += 3) {
        const slice = monthlySeries.slice(i, i + 3);
        const firstYm = slice[0].yearMonth;
        const lastYm = slice[slice.length - 1].yearMonth;
        const qNum = Math.ceil(Number(lastYm.slice(5, 7)) / 3);
        const incSum = slice.reduce((s, x) => s + x.incomeMinor, 0);
        const spdSum = slice.reduce((s, x) => s + x.spendMinor, 0);
        rawBuckets.push({
          key: `${lastYm.slice(0, 4)}-Q${qNum}-${i}`,
          label: `Q${qNum} '${lastYm.slice(2, 4)}`,
          subLabel: `${firstYm} → ${lastYm}`,
          incomeMinor: incSum,
          spendMinor: spdSum,
          savedMinor: incSum - spdSum,
        });
      }
    } else {
      // Group 120 months (10Y) into 10 annual buckets (12 months each)
      for (let i = 0; i < monthlySeries.length; i += 12) {
        const slice = monthlySeries.slice(i, i + 12);
        const firstYm = slice[0].yearMonth;
        const lastYm = slice[slice.length - 1].yearMonth;
        const incSum = slice.reduce((s, x) => s + x.incomeMinor, 0);
        const spdSum = slice.reduce((s, x) => s + x.spendMinor, 0);
        rawBuckets.push({
          key: `${lastYm.slice(0, 4)}-${i}`,
          label: lastYm.slice(0, 4),
          subLabel: `${firstYm} → ${lastYm}`,
          incomeMinor: incSum,
          spendMinor: spdSum,
          savedMinor: incSum - spdSum,
        });
      }
    }

    let runningCumSaved = 0;
    const horizonBuckets = rawBuckets.map((b) => {
      runningCumSaved += b.savedMinor;
      return {
        ...b,
        cumulativeSavedMinor: runningCumSaved,
        savingsRatePct: b.incomeMinor > 0 ? Math.round((b.savedMinor / b.incomeMinor) * 1000) / 10 : 0,
      };
    });

    const activeWindowSeries = horizonMonths === 1 ? monthlySeries.slice(-1) : monthlySeries;
    const horizonTotalIncomeMinor = activeWindowSeries.reduce((s, m) => s + m.incomeMinor, 0);
    const horizonTotalSpendMinor = activeWindowSeries.reduce((s, m) => s + m.spendMinor, 0);
    const horizonTotalSavedMinor = horizonTotalIncomeMinor - horizonTotalSpendMinor;
    const horizonSummary = {
      horizonMonths,
      chartMonthsCount,
      startYearMonth: activeWindowSeries[0]?.yearMonth || ym,
      endYearMonth: ym,
      totalIncomeMinor: horizonTotalIncomeMinor,
      totalSpendMinor: horizonTotalSpendMinor,
      totalSavedMinor: horizonTotalSavedMinor,
      avgMonthlyIncomeMinor: Math.round(horizonTotalIncomeMinor / Math.max(1, activeWindowSeries.length)),
      avgMonthlySpendMinor: Math.round(horizonTotalSpendMinor / Math.max(1, activeWindowSeries.length)),
      savingsRatePct:
        horizonTotalIncomeMinor > 0
          ? Math.round((horizonTotalSavedMinor / horizonTotalIncomeMinor) * 1000) / 10
          : 0,
      buckets: horizonBuckets,
    };

    // When zoomed out (3M / 6M / 12M / 5Y / 10Y), expand BOTH `timelineLedger` (table history)
    // and `dailyCurve` (Timeline graph) to span the entire selected horizon!
    if (horizonMonths > 1) {
      const periodMonths = prevYearMonths(ym, horizonMonths);
      const startPeriodYm = periodMonths[0];

      // 1. Add all historical logged expenses in [startPeriodYm .. prevYm] to timelineLedger
      for (const exp of allHistoryExpenses) {
        const expYm = exp.spentDate.slice(0, 7);
        if (expYm >= ym || expYm < startPeriodYm) continue;
        const timePart =
          exp.createdAt && exp.createdAt.length >= 16 && /^\d{2}:\d{2}/.test(exp.createdAt.slice(11, 16))
            ? exp.createdAt.slice(11, 16)
            : '12:00';
        const timestamp = `${exp.spentDate}T${timePart}:00Z`;
        const day = Math.min(28, Math.max(1, Number(exp.spentDate.slice(8, 10)) || 1));
        const pot = exp.potId ? potById.get(exp.potId) : undefined;
        const dispMinor = convertMinor(exp.amountMinor, exp.currency, cur, rateMap);
        timelineLedger.push({
          id: `led-exp-${exp.id}`,
          kind: 'expense',
          flowDirection: exp.flowDirection === 'inflow' ? 'inflow' : 'outflow',
          entityType: 'expense',
          entityId: exp.id,
          workspaceId: exp.workspaceId,
          accountId: exp.accountId ?? null,
          accountName: exp.accountId ? (accById.get(exp.accountId)?.name ?? null) : null,
          potId: exp.potId,
          potName: pot?.name ?? null,
          potColor: pot?.color ?? (exp.flowDirection === 'inflow' ? '#10B981' : '#E11D48'),
          title: exp.merchant,
          subtitle: exp.description || '',
          date: exp.spentDate,
          timestamp,
          day,
          amountMinor: exp.amountMinor,
          currency: exp.currency,
          displayAmountMinor: dispMinor,
        });
      }

      // 2. Add historical completed scheduled bills across past months in the period (up to 24 most recent months of bill rows)
      const billHistoryMonths = periodMonths.slice(0, -1).slice(-24);
      for (const mKey of billHistoryMonths) {
        const mInc = incomes.reduce((s, i) => s + computeMonthlyIncomeMinor(i, mKey, cur, rateMap), 0);
        if (mInc <= 0) continue;
        const mOccs = store.listPaymentOccurrences(
          mKey,
          obligations.map((o) => o.id)
        );
        const mOccByOb = new Map(mOccs.map((o) => [o.obligationId, o]));

        for (const ob of obligations) {
          if (!ob.isActive) continue;
          if (mKey < '2022-09' && ob.id === 'ob-mortgage') continue;
          const occ = mOccByOb.get(ob.id);
          if (occ && occ.status === 'paid') {
            const eventDate =
              occ.paidAt && occ.paidAt.slice(0, 7) === mKey
                ? occ.paidAt.slice(0, 10)
                : `${mKey}-${String(Math.min(28, Math.max(1, ob.dueDay || 1))).padStart(2, '0')}`;
            const timePart =
              occ.paidAt && occ.paidAt.length >= 16 && /^\d{2}:\d{2}/.test(occ.paidAt.slice(11, 16))
                ? occ.paidAt.slice(11, 16)
                : '09:00';
            const actualNativeMinor = occ.actualPaidMinor ?? ob.amountMinor;
            const dispMinor = convertMinor(actualNativeMinor, ob.currency, cur, rateMap);
            const pot = ob.potId ? potById.get(ob.potId) : undefined;
            const effAccId = (occ.accountId ?? ob.accountId) || null;
            timelineLedger.push({
              id: `led-occ-${occ.id}`,
              kind: 'paid_bill',
              flowDirection: 'outflow',
              entityType: 'obligation',
              entityId: ob.id,
              occurrenceId: occ.id,
              workspaceId: ob.workspaceId,
              accountId: effAccId,
              accountName: effAccId ? (accById.get(effAccId)?.name ?? null) : null,
              potId: ob.potId,
              potName: pot?.name ?? null,
              potColor: pot?.color ?? '#059669',
              title: ob.name,
              subtitle: ob.cadence,
              date: eventDate,
              timestamp: `${eventDate}T${timePart}:00Z`,
              day: Number(eventDate.slice(8, 10)) || ob.dueDay || 1,
              amountMinor: actualNativeMinor,
              currency: ob.currency,
              displayAmountMinor: dispMinor,
            });
          } else if (!occ && ob.cadence === 'monthly') {
            // Historical monthly bill completed on its scheduled due day in past month mKey
            const dueDayClamped = String(Math.min(28, Math.max(1, ob.dueDay || 1))).padStart(2, '0');
            const eventDate = `${mKey}-${dueDayClamped}`;
            const dispMinor = convertMinor(ob.amountMinor, ob.currency, cur, rateMap);
            const pot = ob.potId ? potById.get(ob.potId) : undefined;
            const effAccId = ob.accountId || null;
            timelineLedger.push({
              id: `led-hist-${ob.id}-${mKey}`,
              kind: 'paid_bill',
              flowDirection: 'outflow',
              entityType: 'obligation',
              entityId: ob.id,
              workspaceId: ob.workspaceId,
              accountId: effAccId,
              accountName: effAccId ? (accById.get(effAccId)?.name ?? null) : null,
              potId: ob.potId,
              potName: pot?.name ?? null,
              potColor: pot?.color ?? '#059669',
              title: ob.name,
              subtitle: `${ob.cadence} (${mKey})`,
              date: eventDate,
              timestamp: `${eventDate}T09:00:00Z`,
              day: Number(dueDayClamped),
              amountMinor: ob.amountMinor,
              currency: ob.currency,
              displayAmountMinor: dispMinor,
            });
          }
        }
      }

      timelineLedger.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));

      // 3. Rebuild `dailyCurve` to plot the multi-period trajectory across the selected horizon
      dailyCurve.length = 0;
      if (horizonMonths <= 12) {
        // For 3M / 6M / 12M: plot 3 intra-month checkpoints per month (01 Early Bills, 15 Mid-Month Bills & Expenses, 27 Salary Arrival)
        const rawPoints: Array<{
          date: string;
          label?: string;
          deltaMinor: number;
          events: (typeof dailyCurve)[number]['events'];
        }> = [];

        for (const mKey of periodMonths) {
          const isCurrentMo = mKey === ym;
          const mLedger = timelineLedger.filter((e) => e.date.slice(0, 7) === mKey);

          // Checkpoint 1: Early-month (Days 1..10)
          const earlyEvents: (typeof dailyCurve)[number]['events'] = [];
          let earlyDelta = 0;
          for (const e of mLedger.filter((x) => x.day <= 10)) {
            if (e.flowDirection === 'inflow') {
              earlyDelta += e.displayAmountMinor;
              earlyEvents.push({ id: e.id, kind: 'income', title: e.title, timestamp: e.timestamp, displayMinor: e.displayAmountMinor });
            } else {
              earlyDelta -= e.displayAmountMinor;
              earlyEvents.push({ id: e.id, kind: e.kind, title: e.title, timestamp: e.timestamp, displayMinor: e.displayAmountMinor });
            }
          }
          if (isCurrentMo) {
            for (const ob of enrichedObligations.filter((o) => !o.isPaidThisMonth && (o.dueDay || 1) <= 10)) {
              const amt = ob.metrics.isDueThisMonth ? ob.dueDisplayMinor : ob.preserveDisplayMinor;
              if (amt > 0) {
                earlyDelta -= amt;
                earlyEvents.push({ id: ob.id, kind: 'unpaid_bill', title: ob.name, displayMinor: amt });
              }
            }
          }
          rawPoints.push({
            date: `${mKey}-01`,
            label: `${mKey.slice(5)}/${mKey.slice(2, 4)}`,
            deltaMinor: earlyDelta,
            events: earlyEvents,
          });

          // Checkpoint 2: Mid-month bills & shop expenses (Days 11..25)
          const midEvents: (typeof dailyCurve)[number]['events'] = [];
          let midDelta = 0;
          for (const e of mLedger.filter((x) => x.day >= 11 && x.day <= 25)) {
            if (e.flowDirection === 'inflow') {
              midDelta += e.displayAmountMinor;
              midEvents.push({ id: e.id, kind: 'income', title: e.title, timestamp: e.timestamp, displayMinor: e.displayAmountMinor });
            } else {
              midDelta -= e.displayAmountMinor;
              midEvents.push({ id: e.id, kind: e.kind, title: e.title, timestamp: e.timestamp, displayMinor: e.displayAmountMinor });
            }
          }
          if (isCurrentMo) {
            for (const ob of enrichedObligations.filter((o) => !o.isPaidThisMonth && (o.dueDay || 1) >= 11 && (o.dueDay || 1) <= 25)) {
              const amt = ob.metrics.isDueThisMonth ? ob.dueDisplayMinor : ob.preserveDisplayMinor;
              if (amt > 0) {
                midDelta -= amt;
                midEvents.push({ id: ob.id, kind: 'unpaid_bill', title: ob.name, displayMinor: amt });
              }
            }
          }
          rawPoints.push({
            date: `${mKey}-15`,
            deltaMinor: midDelta,
            events: midEvents,
          });

          // Checkpoint 3: Payday & Month-End (Days 26..31)
          const lateEvents: (typeof dailyCurve)[number]['events'] = [];
          let lateDelta = 0;
          for (const inc of incomes) {
            const incMinor = computeMonthlyIncomeMinor(inc, mKey, cur, rateMap);
            if (incMinor > 0) {
              lateDelta += incMinor;
              lateEvents.push({
                id: `inc-${inc.id}-${mKey}`,
                kind: 'income',
                title: isCurrentMo && !activeIncomes.find((a) => a.id === inc.id)?.isReceivedThisMonth
                  ? `${inc.name} (expected)`
                  : `${inc.name} ✓`,
                timestamp: `${mKey}-${String(Math.min(28, Math.max(1, inc.paydayDay))).padStart(2, '0')}`,
                displayMinor: incMinor,
              });
            }
          }
          for (const e of mLedger.filter((x) => x.day >= 26)) {
            if (e.flowDirection === 'inflow') {
              lateDelta += e.displayAmountMinor;
              lateEvents.push({ id: e.id, kind: 'income', title: e.title, timestamp: e.timestamp, displayMinor: e.displayAmountMinor });
            } else {
              lateDelta -= e.displayAmountMinor;
              lateEvents.push({ id: e.id, kind: e.kind, title: e.title, timestamp: e.timestamp, displayMinor: e.displayAmountMinor });
            }
          }
          rawPoints.push({
            date: `${mKey}-27`,
            deltaMinor: lateDelta,
            events: lateEvents,
          });
        }

        // Compute running balance anchored so the final point equals projectedEndBalanceMinor
        const totalDelta = rawPoints.reduce((s, p) => s + p.deltaMinor, 0);
        let bal = projectedEndBalanceMinor - totalDelta;
        rawPoints.forEach((pt, idx) => {
          bal += pt.deltaMinor;
          dailyCurve.push({
            day: idx + 1,
            date: pt.date,
            balanceMinor: bal,
            label: pt.label,
            events: pt.events,
          });
        });
      } else {
        // For 5Y (60M) and 10Y (120M): plot quarterly / annual trajectory buckets with summarized events
        const totalSaved = horizonBuckets.reduce((s, b) => s + b.savedMinor, 0);
        let bal = Math.max(0, projectedEndBalanceMinor - totalSaved);
        horizonBuckets.forEach((b, idx) => {
          bal += b.savedMinor;
          const bEvents: (typeof dailyCurve)[number]['events'] = [];
          if (b.incomeMinor > 0) {
            bEvents.push({
              id: `b-inc-${b.key}`,
              kind: 'income',
              title: `Salary & Income (${b.label})`,
              displayMinor: b.incomeMinor,
            });
          }
          if (b.spendMinor > 0) {
            bEvents.push({
              id: `b-spd-${b.key}`,
              kind: 'paid_bill',
              title: `Bills & Living Spend (${b.label})`,
              displayMinor: b.spendMinor,
            });
          }
          dailyCurve.push({
            day: idx + 1,
            date: b.subLabel,
            balanceMinor: bal,
            label: b.label,
            events: bEvents,
          });
        });
      }
    }

    return {
      yearMonth: ym,
      scope,
      displayCurrency: cur,
      accounts,
      allAccounts,
      allLiabilities,
      incomes: activeIncomes,
      allIncomes: incomes,
      pots,
      potTree,
      obligations: enrichedObligations,
      expenses,
      timelineLedger,
      kpis: {
        totalIncomeMinor,
        potPlannedTotalMinor,
        totalPreserveSliceMinor,
        netMonthlySurplusMinor,
        savingsRatePct: totalIncomeMinor > 0 ? Math.round((netMonthlySurplusMinor / totalIncomeMinor) * 1000) / 10 : 0,
      },
      runway: {
        runwayCashMinor,
        remainingPaydaysIncomeMinor,
        unpaidBillsMinor,
        unpaidPrePaydayBillsMinor,
        totalPreserveSliceMinor,
        unallocatedEnvelopeRemainingMinor,
        totalNeededBeforePaydayMinor,
        prePaydayBufferMinor,
        currentCashAfterMonthBillsMinor,
        totalNeededTillMonthEndMinor,
        projectedEndBalanceMinor,
        projectedAfterNextMonthReserveMinor,
        shortfallMinor,
        isSufficient: prePaydayBufferMinor >= 0,
        dailyCurve,
      },
      cashflowBridge: {
        prevYearMonth: prevYm,
        nextYearMonth: nextYm,
        primaryPaydayDay,
        overflowInMinor,
        thisMonthSpendingMinor: potPlannedTotalMinor,
        thisMonthBufferMinor,
        thisMonthShortfallMinor,
        upcomingSalaryTotalMinor,
        upcomingSalaryReceivedMinor,
        upcomingSalaryPendingMinor,
        nextMonthPreSalaryMinor,
        projectedFreeFromUpcomingMinor,
        nextMonthBreakdown,
      },
      sankey: {
        nodes: sankeyNodes,
        links: sankeyLinks,
      },
      trend6m,
      horizonSummary,
    };
  });

  // Wealth, Belongings & Long-Horizon Forecast Endpoint
  app.get('/api/wealth/overview', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;

    const q = (req.query || {}) as { horizon?: string; past?: string; scope?: string };
    const horizonYears = Math.min(30, Math.max(0, q.horizon !== undefined ? Number(q.horizon) : 5));
    const pastYears = Math.min(20, Math.max(0, q.past !== undefined ? Number(q.past) : 5));
    const scope = q.scope || 'all';
    const cur = user.defaultCurrency;
    const rateMap = buildRateMap(store.getFxRates());
    const ym = new Date().toISOString().slice(0, 7);
    const currentYear = Number(ym.slice(0, 4));

    const workspaces = store.getWorkspaces();
    const isPrimaryCouple = user.id === 'usr-wadera' || user.id === 'usr-walter';
    const partnerWs = isPrimaryCouple
      ? workspaces.find(
          (w) =>
            w.kind === 'personal' &&
            w.ownerUserId !== user.id &&
            (w.ownerUserId === 'usr-wadera' || w.ownerUserId === 'usr-walter')
        ) ?? null
      : workspaces.find(
          (w) => w.kind === 'personal' && w.ownerUserId !== user.id && store.canIncludeInCombinedWealth(user.id, w.id)
        ) ?? null;

    const summarizeWs = (wsId: string, scaleFactor = 1.0) => {
      const assets = store.listAssets([wsId]);
      const liabilities = store.listLiabilities([wsId]);
      const accounts = store.listAccounts([wsId]);
      const cashMinor = Math.round(
        accounts.reduce((s, a) => s + convertMinor(a.balanceMinor, a.currency, cur, rateMap), 0) * scaleFactor
      );
      const assetsMinor = Math.round(
        assets.reduce((s, a) => s + convertMinor(a.currentValueMinor, a.currency, cur, rateMap), 0) * scaleFactor
      );
      const liabilitiesMinor = Math.round(
        liabilities.reduce((s, l) => s + convertMinor(l.balanceMinor, l.currency, cur, rateMap), 0) * scaleFactor
      );
      return {
        cashMinor,
        assetsMinor,
        totalAssetsMinor: cashMinor + assetsMinor,
        liabilitiesMinor,
        netWorthMinor: cashMinor + assetsMinor - liabilitiesMinor,
        assets,
        liabilities,
        accounts,
      };
    };

    const personalSummary = summarizeWs(user.personalWorkspaceId, 1.0);
    const hasHomeShare = store.canIncludeInCombinedWealth(user.id, 'ws-home');
    const sharedHalfSummary = hasHomeShare
      ? summarizeWs('ws-home', 0.5)
      : {
          cashMinor: 0,
          assetsMinor: 0,
          totalAssetsMinor: 0,
          liabilitiesMinor: 0,
          netWorthMinor: 0,
          assets: [],
          liabilities: [],
          accounts: [],
        };

    const myTotalAssetsMinor = personalSummary.totalAssetsMinor + sharedHalfSummary.totalAssetsMinor;
    const myTotalLiabilitiesMinor = personalSummary.liabilitiesMinor + sharedHalfSummary.liabilitiesMinor;
    const myNetWorthMinor = myTotalAssetsMinor - myTotalLiabilitiesMinor;

    // Partner summary respecting partnerVisibility ('private' | 'totals_only' | 'readonly')
    let partnerSummaryPublic: {
      visibility: PartnerVisibility;
      includedInCombined: boolean;
      totalAssetsMinor: number | null;
      totalLiabilitiesMinor: number | null;
      netWorthMinor: number | null;
    } = {
      visibility: partnerWs?.partnerVisibility ?? 'private',
      includedInCombined: false,
      totalAssetsMinor: null,
      totalLiabilitiesMinor: null,
      netWorthMinor: null,
    };

    if (partnerWs && store.canIncludeInCombinedWealth(user.id, partnerWs.id)) {
      const pOwn = summarizeWs(partnerWs.id, 1.0);
      partnerSummaryPublic = {
        visibility: partnerWs.partnerVisibility,
        includedInCombined: true,
        totalAssetsMinor: pOwn.totalAssetsMinor + sharedHalfSummary.totalAssetsMinor,
        totalLiabilitiesMinor: pOwn.liabilitiesMinor + sharedHalfSummary.liabilitiesMinor,
        netWorthMinor: pOwn.netWorthMinor + sharedHalfSummary.netWorthMinor,
      };
    }

    // Combined Wealth across all workspaces permitted by privacy/membership scope (or scoped workspace when selected)
    const allCombinedWsIds = workspaces
      .filter((w) => store.canIncludeInCombinedWealth(user.id, w.id))
      .map((w) => w.id);
    const combinedWsIds =
      scope && scope !== 'all' ? store.readableWorkspaceIds(user.id, scope) : allCombinedWsIds;

    const combinedAssets = store.listAssets(combinedWsIds);
    const combinedLiabilities = store.listLiabilities(combinedWsIds);
    const combinedAccounts = store.listAccounts(combinedWsIds);
    const combinedCashMinor = combinedAccounts.reduce(
      (s, a) => s + convertMinor(a.balanceMinor, a.currency, cur, rateMap),
      0
    );

    // Estimate monthly net family/workspace savings for long-horizon projection
    const combinedIncomes = store
      .listIncomes(combinedWsIds)
      .reduce((s, i) => s + computeMonthlyIncomeMinor(i, ym, cur, rateMap), 0);
    const combinedPots = store.listPots(combinedWsIds);
    const combinedObs = store.listObligations(combinedWsIds);
    const combinedExps = store.listExpenses(combinedWsIds, ym, ym);
    const combinedTree = buildPotRollupTree(combinedPots, combinedObs, combinedExps, ym, cur, rateMap);
    const combinedMonthlySpend = combinedTree.reduce((s, n) => s + n.effectiveTotalDisplayMinor, 0);
    const estMonthlySavings = Math.max(0, combinedIncomes - combinedMonthlySpend);

    const horizonProjection = projectWealthHorizon({
      startYear: currentYear,
      horizonYears,
      assets: combinedAssets,
      liabilities: combinedLiabilities,
      bankCashDisplayMinor: combinedCashMinor,
      monthlyNetSavingsDisplayMinor: estMonthlySavings,
      displayCurrency: cur,
      rateMap,
    });

    const myScaledAssets = [
      ...personalSummary.assets,
      ...sharedHalfSummary.assets.map((a) => ({
        ...a,
        currentValueMinor: Math.round(a.currentValueMinor * 0.5),
        purchasePriceMinor: Math.round(a.purchasePriceMinor * 0.5),
        residualFloorMinor: Math.round(a.residualFloorMinor * 0.5),
      })),
    ];
    const myScaledLiabilities = [
      ...personalSummary.liabilities,
      ...sharedHalfSummary.liabilities.map((l) => ({
        ...l,
        balanceMinor: Math.round(l.balanceMinor * 0.5),
        monthlyPaymentMinor: Math.round(l.monthlyPaymentMinor * 0.5),
      })),
    ];
    const myCashMinor = personalSummary.cashMinor + sharedHalfSummary.cashMinor;
    const myMonthlySavings = Math.round(estMonthlySavings * (hasHomeShare ? 0.55 : 1.0));

    const myHorizonProjection = projectWealthHorizon({
      startYear: currentYear,
      horizonYears,
      assets: myScaledAssets,
      liabilities: myScaledLiabilities,
      bankCashDisplayMinor: myCashMinor,
      monthlyNetSavingsDisplayMinor: myMonthlySavings,
      displayCurrency: cur,
      rateMap,
    });

    const combinedHistoryPoints = reconstructWealthHistory({
      startYear: currentYear,
      pastYears,
      assets: combinedAssets,
      liabilities: combinedLiabilities,
      bankCashDisplayMinor: combinedCashMinor,
      monthlyNetSavingsDisplayMinor: estMonthlySavings,
      displayCurrency: cur,
      rateMap,
    });

    const myHistoryPoints = reconstructWealthHistory({
      startYear: currentYear,
      pastYears,
      assets: myScaledAssets,
      liabilities: myScaledLiabilities,
      bankCashDisplayMinor: myCashMinor,
      monthlyNetSavingsDisplayMinor: myMonthlySavings,
      displayCurrency: cur,
      rateMap,
    });

    const combinedHistory = combinedHistoryPoints.map((pt) => ({
      date: `${pt.year}-01-01`,
      year: pt.year,
      netWorthMinor: pt.netWorthMinor,
      assetsMinor: pt.totalAssetsMinor,
      liabilitiesMinor: pt.totalLiabilitiesMinor,
    }));

    const myHistory = myHistoryPoints.map((pt) => ({
      date: `${pt.year}-01-01`,
      year: pt.year,
      netWorthMinor: pt.netWorthMinor,
      assetsMinor: pt.totalAssetsMinor,
      liabilitiesMinor: pt.totalLiabilitiesMinor,
    }));

    // Visible item lists (never expose partner items unless partnerVisibility === 'readonly')
    const itemVisibleWsIds = store.readableWorkspaceIds(user.id, scope);
    const visibleAssets = store.listAssets(itemVisibleWsIds).map((a) => ({
      ...a,
      displayValueMinor: convertMinor(a.currentValueMinor, a.currency, cur, rateMap),
      displayPurchaseMinor: convertMinor(a.purchasePriceMinor, a.currency, cur, rateMap),
    }));
    const visibleLiabilities = store.listLiabilities(itemVisibleWsIds).map((l) => ({
      ...l,
      displayBalanceMinor: convertMinor(l.balanceMinor, aCurrency(l.currency), cur, rateMap),
      displayMonthlyMinor: convertMinor(l.monthlyPaymentMinor, aCurrency(l.currency), cur, rateMap),
    }));

    function aCurrency(c: CurrencyCode): CurrencyCode {
      return c || 'GBP';
    }

    const salaryWsIds = scope && scope !== 'all' ? itemVisibleWsIds : [user.personalWorkspaceId];

    return {
      displayCurrency: cur,
      horizonYears,
      pastYears,
      scope,
      myWealth: {
        totalAssetsMinor: myTotalAssetsMinor,
        totalLiabilitiesMinor: myTotalLiabilitiesMinor,
        netWorthMinor: myNetWorthMinor,
        history: myHistory,
        projection: myHorizonProjection,
      },
      partnerWealth: partnerSummaryPublic,
      combinedFamilyWealth: {
        totalAssetsMinor: horizonProjection[0]?.totalAssetsMinor ?? 0,
        totalLiabilitiesMinor: horizonProjection[0]?.totalLiabilitiesMinor ?? 0,
        netWorthMinor: horizonProjection[0]?.netWorthMinor ?? 0,
        estMonthlySavingsMinor: estMonthlySavings,
        history: combinedHistory,
        projection: horizonProjection,
      },
      assets: visibleAssets,
      liabilities: visibleLiabilities,
      salaryHistory: store.listIncomes(salaryWsIds),
    };
  });

  // --- CRUD: Settings ---
  app.patch('/api/settings/preferences', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const body = (req.body || {}) as {
      defaultCurrency?: CurrencyCode;
      locale?: LocaleCode;
      partnerVisibility?: PartnerVisibility;
      sharedSplitMode?: SplitMode;
      waderaCustomSplitBp?: number;
      fxRates?: Array<{ currency: CurrencyCode; rateToGbp: number }>;
    };

    if (body.defaultCurrency) {
      store.updateUserDefaultCurrency(user.id, body.defaultCurrency);
    }
    if (body.locale === 'en' || body.locale === 'pl') {
      store.updateUserLocale(user.id, body.locale);
    }
    if (body.partnerVisibility) {
      store.updateWorkspaceSettings(user.personalWorkspaceId, {
        partnerVisibility: body.partnerVisibility,
      });
    }
    if ((body.sharedSplitMode || body.waderaCustomSplitBp != null) && store.canWriteWorkspace(user.id, 'ws-home')) {
      store.updateWorkspaceSettings('ws-home', {
        defaultSplitMode: body.sharedSplitMode,
        waderaCustomSplitBp: body.waderaCustomSplitBp,
      });
    }
    if (Array.isArray(body.fxRates) && user.isAdmin) {
      for (const r of body.fxRates) {
        if (r.rateToGbp > 0) store.updateFxRate(r.currency, Number(r.rateToGbp));
      }
    }
    return { ok: true };
  });

  // --- CRUD: Multi-Workspaces & Sharing (Company A, Company B, Household, Family, Personal) ---
  app.post('/api/workspaces', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const body = (req.body || {}) as {
      name?: string;
      kind?: WorkspaceKind;
      sharedMembers?: Array<{ userId: string; role: WorkspaceRole }>;
    };
    const name = String(body.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'Workspace name is required' });
    const kind: WorkspaceKind =
      body.kind === 'company' ? 'company' : body.kind === 'shared' ? 'shared' : 'personal';
    const created = store.createWorkspace({
      ownerUserId: user.id,
      name,
      kind,
      sharedMembers: body.sharedMembers,
    });
    return { ok: true, workspace: created };
  });

  app.patch('/api/workspaces/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!store.canManageWorkspace(user.id, id)) {
      return reply.code(403).send({ error: 'Only workspace owner can update workspace settings' });
    }
    const body = (req.body || {}) as {
      name?: string;
      kind?: WorkspaceKind;
      partnerVisibility?: PartnerVisibility;
      defaultSplitMode?: SplitMode;
    };
    store.updateWorkspaceSettings(id, body);
    return { ok: true };
  });

  app.delete('/api/workspaces/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (id === user.personalWorkspaceId || id === 'ws-wadera' || id === 'ws-walter' || id === 'ws-home') {
      return reply.code(400).send({ error: 'Default personal or primary household workspace cannot be deleted' });
    }
    if (!store.canManageWorkspace(user.id, id)) {
      return reply.code(403).send({ error: 'Only workspace owner can delete this workspace' });
    }
    store.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
    return { ok: true };
  });

  app.post('/api/workspaces/:id/members', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    if (!store.canManageWorkspace(user.id, id)) {
      return reply.code(403).send({ error: 'Only workspace owner can share this workspace' });
    }
    const body = (req.body || {}) as { userId?: string; role?: WorkspaceRole };
    const targetUserId = String(body.userId || '');
    const role = (body.role || 'editor') as WorkspaceRole;
    if (!targetUserId || !['editor', 'viewer', 'totals_only', 'owner'].includes(role)) {
      return reply.code(400).send({ error: 'Valid userId and role required' });
    }
    const targetUser = store.getUserById(targetUserId);
    if (!targetUser) return reply.code(404).send({ error: 'Target user not found' });
    store.setWorkspaceMember(id, targetUserId, role);
    return { ok: true, members: store.listWorkspaceMembers(id) };
  });

  app.delete('/api/workspaces/:id/members/:targetUserId', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id, targetUserId } = req.params as { id: string; targetUserId: string };
    const ws = store.getWorkspaces().find((w) => w.id === id);
    if (!ws) return reply.code(404).send({ error: 'Workspace not found' });
    if (ws.ownerUserId === targetUserId) {
      return reply.code(400).send({ error: 'Cannot remove workspace owner' });
    }
    if (!store.canManageWorkspace(user.id, id) && user.id !== targetUserId) {
      return reply.code(403).send({ error: 'Permission denied' });
    }
    store.removeWorkspaceMember(id, targetUserId);
    return { ok: true, members: store.listWorkspaceMembers(id) };
  });

  // --- CRUD: Local Accounts & User Invitations (Admin Only) ---
  app.post('/api/users/local', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    if (!user.isAdmin) {
      return reply.code(403).send({ error: 'Admin privileges required to create local user accounts' });
    }
    const body = (req.body || {}) as {
      handle?: string;
      displayName?: string;
      email?: string;
      password?: string;
      defaultCurrency?: CurrencyCode;
      locale?: LocaleCode;
      isAdmin?: boolean;
      sharedWorkspaceGrants?: Array<{ workspaceId: string; role: WorkspaceRole }>;
    };
    try {
      const created = store.createLocalUser({
        handle: String(body.handle || ''),
        displayName: String(body.displayName || body.handle || ''),
        email: body.email ? String(body.email) : undefined,
        password: String(body.password || ''),
        defaultCurrency: body.defaultCurrency || 'GBP',
        locale: body.locale === 'pl' ? 'pl' : 'en',
        isAdmin: Boolean(body.isAdmin),
        sharedWorkspaceGrants: body.sharedWorkspaceGrants,
      });
      return { ok: true, user: created };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to create local user' });
    }
  });

  app.patch('/api/users/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'Admin privileges required' });
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as {
      newPassword?: string;
      isActive?: boolean;
      displayName?: string;
    };
    try {
      if (body.newPassword) {
        store.setUserPassword(id, body.newPassword);
      }
      if (typeof body.isActive === 'boolean' && id !== user.id && id !== 'usr-wadera') {
        store.db.prepare(`UPDATE users SET is_active = ? WHERE id = ?`).run(body.isActive ? 1 : 0, id);
      }
      if (body.displayName?.trim()) {
        store.db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(body.displayName.trim(), id);
      }
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'Admin privileges required' });
    const { id } = req.params as { id: string };
    if (id === user.id || id === 'usr-wadera' || id === 'usr-walter') {
      return reply.code(400).send({ error: 'Cannot delete primary household owner account' });
    }
    const target = store.getUsers().find((u) => u.id === id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    store.db.prepare(`DELETE FROM workspaces WHERE owner_user_id = ?`).run(id);
    store.db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
    return { ok: true };
  });

  app.post('/api/settings/api-keys', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const body = (req.body || {}) as { label?: string };
    const created = store.createApiKey(user.id, (body.label || 'MCP Receipt Connector').trim());
    return created;
  });

  app.delete('/api/settings/api-keys/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    store.revokeApiKey(user.id, id);
    return { ok: true };
  });

  app.post('/api/settings/sample-data', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'Admin privileges required' });
    const body = (req.body || {}) as { action?: 'load' | 'clear' };
    if (body.action === 'clear') {
      store.clearAllFinancialRecords();
    } else {
      store.loadStarterHouseholdSample();
    }
    return { ok: true };
  });

  app.get('/api/settings/backup', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'Admin privileges required' });
    const snapPath = store.createBackupSnapshot();
    const fileName = path.basename(snapPath);
    reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    reply.type('application/vnd.sqlite3');
    return fs.createReadStream(snapPath);
  });

  // --- CRUD: Bank Accounts ---
  app.post('/api/accounts', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const wsId = String(b.workspaceId || user.personalWorkspaceId);
    if (!store.canWriteWorkspace(user.id, wsId)) return reply.code(403).send({ error: 'Write denied' });
    const id = b.id ? String(b.id) : `acc-${crypto.randomUUID().slice(0, 8)}`;
    store.db
      .prepare(
        `INSERT INTO accounts (id, workspace_id, name, institution, currency, balance_minor, is_primary_runway, portal_url, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, name=excluded.name, institution=excluded.institution, currency=excluded.currency,
           balance_minor=excluded.balance_minor, is_primary_runway=excluded.is_primary_runway,
           portal_url=excluded.portal_url, notes=excluded.notes, updated_at=excluded.updated_at`
      )
      .run(
        id,
        wsId,
        String(b.name || 'Account'),
        String(b.institution || ''),
        String(b.currency || user.defaultCurrency),
        Math.round(Number(b.balanceMinor ?? 0)),
        b.isPrimaryRunway === false ? 0 : 1,
        b.portalUrl ? String(b.portalUrl) : null,
        b.notes ? String(b.notes) : null,
        new Date().toISOString()
      );
    return { ok: true, id };
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db.prepare(`SELECT workspace_id FROM accounts WHERE id = ?`).get(id) as { workspace_id: string } | undefined;
    if (!row || !store.canWriteWorkspace(user.id, row.workspace_id)) return reply.code(403).send({ error: 'Denied' });
    store.db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    return { ok: true };
  });

  // --- CRUD: Income Streams ---
  app.post('/api/incomes', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const wsId = String(b.workspaceId || user.personalWorkspaceId);
    if (!store.canWriteWorkspace(user.id, wsId)) return reply.code(403).send({ error: 'Write denied' });
    const id = b.id ? String(b.id) : `inc-${crypto.randomUUID().slice(0, 8)}`;
    const currency = String(b.currency || user.defaultCurrency) as CurrencyCode;
    const existingInc = b.id
      ? (store.db.prepare(`SELECT account_id FROM income_streams WHERE id = ?`).get(id) as
          | { account_id: string | null }
          | undefined)
      : undefined;
    const accountId =
      b.accountId !== undefined
        ? b.accountId
          ? String(b.accountId)
          : null
        : existingInc !== undefined
        ? existingInc.account_id
        : defaultAccountForWorkspace(store, wsId, currency);

    store.db
      .prepare(
        `INSERT INTO income_streams (id, workspace_id, account_id, name, source_kind, amount_minor, currency, cadence, payday_day, effective_from, effective_to, is_active, portal_url, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, account_id=excluded.account_id, name=excluded.name, source_kind=excluded.source_kind, amount_minor=excluded.amount_minor,
           currency=excluded.currency, cadence=excluded.cadence, payday_day=excluded.payday_day,
           effective_from=excluded.effective_from, effective_to=excluded.effective_to,
           is_active=excluded.is_active, portal_url=excluded.portal_url, notes=excluded.notes`
      )
      .run(
        id,
        wsId,
        accountId,
        String(b.name || 'Salary'),
        String(b.sourceKind || 'salary'),
        Math.round(Number(b.amountMinor ?? 0)),
        currency,
        String(b.cadence || 'monthly'),
        Math.min(28, Math.max(1, Number(b.paydayDay ?? 25))),
        String(b.effectiveFrom || new Date().toISOString().slice(0, 10)),
        b.effectiveTo ? String(b.effectiveTo) : null,
        b.isActive === false ? 0 : 1,
        b.portalUrl ? String(b.portalUrl) : null,
        b.notes ? String(b.notes) : null
      );

    // Optional: if user checked "Mark received in bank account now" when creating/logging income
    if (b.markReceivedYearMonth && /^\d{4}-\d{2}$/.test(String(b.markReceivedYearMonth))) {
      const occYm = String(b.markReceivedYearMonth);
      const amtMinor = Math.round(Number(b.amountMinor ?? 0));
      const pDay = Math.min(28, Math.max(1, Number(b.paydayDay ?? 25)));
      const expDate = `${occYm}-${String(pDay).padStart(2, '0')}`;
      const existingOcc = store.db
        .prepare(`SELECT id, status FROM income_occurrences WHERE income_id = ? AND year_month = ?`)
        .get(id, occYm) as { id: string; status: string } | undefined;
      if (!existingOcc || existingOcc.status !== 'received') {
        store.setIncomeReceived({
          incomeId: id,
          accountId,
          yearMonth: occYm,
          expectedDate: expDate,
          amountMinor: amtMinor,
          currency,
          received: true,
        });
        if (accountId && amtMinor > 0) {
          adjustAccountBalance(store, accountId, +amtMinor, currency);
        }
      }
    }

    return { ok: true, id, accountId };
  });

  app.delete('/api/incomes/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db.prepare(`SELECT workspace_id FROM income_streams WHERE id = ?`).get(id) as { workspace_id: string } | undefined;
    if (!row || !store.canWriteWorkspace(user.id, row.workspace_id)) return reply.code(403).send({ error: 'Denied' });
    store.db.prepare(`DELETE FROM income_streams WHERE id = ?`).run(id);
    return { ok: true };
  });

  // Tick / Untick "[✓] Salary / Income Arrived" on the Monthly Timeline Tracker (live deposits into linked Bank Account)
  app.post('/api/incomes/:id/toggle-received', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { yearMonth?: string; received?: boolean; accountId?: string | null };
    const ym = body.yearMonth && /^\d{4}-\d{2}$/.test(body.yearMonth) ? body.yearMonth : new Date().toISOString().slice(0, 7);

    const wsIds = store.readableWorkspaceIds(user.id, 'all');
    const inc = store.listIncomes(wsIds).find((i) => i.id === id);
    if (!inc || !store.canWriteWorkspace(user.id, inc.workspaceId)) {
      return reply.code(403).send({ error: 'Income stream not found or write denied' });
    }

    const existingOcc = store.db
      .prepare(
        `SELECT id, account_id, received_minor, currency, status FROM income_occurrences WHERE income_id = ? AND year_month = ?`
      )
      .get(inc.id, ym) as
      | { id: string; account_id: string | null; received_minor: number; currency: CurrencyCode; status: string }
      | undefined;

    const targetAccountId =
      body.accountId !== undefined
        ? body.accountId || null
        : inc.accountId ?? defaultAccountForWorkspace(store, inc.workspaceId, inc.currency);

    const expectedDate = `${ym}-${String(Math.min(28, Math.max(1, inc.paydayDay))).padStart(2, '0')}`;
    const markReceived = body.received !== false;

    store.db.exec('BEGIN IMMEDIATE;');
    try {
      if (existingOcc && existingOcc.status === 'received' && existingOcc.account_id) {
        // Reverse previous deposit if already marked received
        adjustAccountBalance(store, existingOcc.account_id, -existingOcc.received_minor, existingOcc.currency);
      }

      if (markReceived) {
        store.setIncomeReceived({
          incomeId: inc.id,
          accountId: targetAccountId,
          yearMonth: ym,
          expectedDate,
          amountMinor: inc.amountMinor,
          currency: inc.currency,
          received: true,
        });
        if (targetAccountId) {
          adjustAccountBalance(store, targetAccountId, +inc.amountMinor, inc.currency);
        }
        if (body.accountId !== undefined) {
          store.db.prepare(`UPDATE income_streams SET account_id = ? WHERE id = ?`).run(targetAccountId, inc.id);
        }
      } else {
        store.setIncomeReceived({
          incomeId: inc.id,
          accountId: null,
          yearMonth: ym,
          expectedDate,
          amountMinor: inc.amountMinor,
          currency: inc.currency,
          received: false,
        });
      }
      store.db.exec('COMMIT;');
    } catch (err) {
      store.db.exec('ROLLBACK;');
      throw err;
    }

    return { ok: true, incomeId: inc.id, yearMonth: ym, isReceivedThisMonth: markReceived, accountId: targetAccountId };
  });

  // --- CRUD: Hierarchical Pots (Unlimited Nesting + Item-to-Pot Promotion) ---
  app.post('/api/pots', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const id = b.id ? String(b.id) : `pot-${crypto.randomUUID().slice(0, 8)}`;
    const parentId = b.parentId ? String(b.parentId) : null;

    let parentRow: { id: string; workspace_id: string; parent_id: string | null; color: string } | undefined;
    if (parentId) {
      if (parentId === id) {
        return reply.code(400).send({ error: 'A pot cannot be its own parent' });
      }
      parentRow = store.db
        .prepare(`SELECT id, workspace_id, parent_id, color FROM pots WHERE id = ?`)
        .get(parentId) as typeof parentRow;
      if (!parentRow) {
        return reply.code(400).send({ error: 'Parent pot not found' });
      }
      // Prevent cycles across arbitrary depth
      let cursor: string | null = parentRow.parent_id;
      const seen = new Set<string>([id, parentId]);
      while (cursor) {
        if (seen.has(cursor)) {
          return reply.code(400).send({ error: 'Circular pot hierarchy rejected' });
        }
        seen.add(cursor);
        const ancestor = store.db
          .prepare(`SELECT parent_id FROM pots WHERE id = ?`)
          .get(cursor) as { parent_id: string | null } | undefined;
        cursor = ancestor?.parent_id ?? null;
      }
    }

    const wsId = String(b.workspaceId || parentRow?.workspace_id || 'ws-home');
    if (!store.canWriteWorkspace(user.id, wsId)) return reply.code(403).send({ error: 'Write denied' });

    const color = String(b.color || parentRow?.color || '#2E6F7E');

    store.db
      .prepare(
        `INSERT INTO pots (id, workspace_id, parent_id, name, icon, color, envelope_mode, monthly_estimate_minor, currency, tags_json, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, parent_id=excluded.parent_id, name=excluded.name,
           icon=excluded.icon, color=excluded.color, envelope_mode=excluded.envelope_mode,
           monthly_estimate_minor=excluded.monthly_estimate_minor, currency=excluded.currency,
           tags_json=excluded.tags_json, sort_order=excluded.sort_order`
      )
      .run(
        id,
        wsId,
        parentId,
        String(b.name || 'New Pot'),
        String(b.icon || 'folder'),
        color,
        b.envelopeMode ? 1 : 0,
        Math.round(Number(b.monthlyEstimateMinor ?? 0)),
        String(b.currency || user.defaultCurrency),
        JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
        Number(b.sortOrder ?? 10)
      );
    return { ok: true, id };
  });

  /**
   * Promotes an existing leaf item ('obligation' or 'expense') into a Pot when a new sub-pot or item
   * is added inside it ("By default any item can become a pot if new item is added inside as sub-pot").
   */
  app.post('/api/pots/promote-item', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;

    const body = (req.body || {}) as {
      itemKind?: 'obligation' | 'expense';
      itemId?: string;
      promoteMode?: 'envelope' | 'group';
      child?: {
        kind?: 'pot' | 'obligation' | 'expense';
        name?: string;
        amountMinor?: number;
        currency?: CurrencyCode;
        cadence?: ObligationRecord['cadence'];
        intervalMonths?: number;
        nextDueDate?: string;
        spentDate?: string;
      };
    };

    const itemKind = body.itemKind;
    const itemId = String(body.itemId || '');
    const promoteMode = body.promoteMode === 'group' ? 'group' : 'envelope';
    const child = body.child || {};
    const childKind = child.kind || 'pot';
    const childName = String(child.name || '').trim();
    const childAmountMinor = Math.max(0, Math.round(Number(child.amountMinor ?? 0)));

    if (!itemKind || !itemId || !childName) {
      return reply.code(400).send({ error: 'itemKind, itemId, and child.name are required' });
    }

    const wsIds = store.readableWorkspaceIds(user.id, 'all');
    const palette = ['#2E6F7E', '#3D7A5A', '#47688A', '#7C5E8C', '#B4693E'];

    let wsId = 'ws-home';
    let parentPotId: string | null = null;
    let promotedName = 'New Pot';
    let itemCurrency: CurrencyCode = user.defaultCurrency;
    let envelopeEstimateMinor = 0;

    if (itemKind === 'obligation') {
      const ob = store.listObligations(wsIds).find((o) => o.id === itemId);
      if (!ob || !store.canWriteWorkspace(user.id, ob.workspaceId)) {
        return reply.code(403).send({ error: 'Obligation not found or write denied' });
      }
      wsId = ob.workspaceId;
      parentPotId = ob.potId;
      promotedName = ob.name;
      itemCurrency = ob.currency;

      if (ob.cadence === 'monthly') envelopeEstimateMinor = ob.amountMinor;
      else if (ob.cadence === 'weekly') envelopeEstimateMinor = Math.round((ob.amountMinor * 52) / 12);
      else if (ob.cadence === 'quarterly') envelopeEstimateMinor = Math.round(ob.amountMinor / 3);
      else if (ob.cadence === 'biannual') envelopeEstimateMinor = Math.round(ob.amountMinor / 6);
      else if (ob.cadence === 'annual') envelopeEstimateMinor = Math.round(ob.amountMinor / 12);
      else if (ob.cadence === 'custom_months') {
        envelopeEstimateMinor = Math.round(ob.amountMinor / Math.max(1, ob.intervalMonths));
      } else {
        const ymNow = new Date().toISOString().slice(0, 7);
        const m = computeObligationMonthMetrics(ob, ymNow);
        envelopeEstimateMinor = m.effectiveMonthlyBurdenNativeMinor || ob.amountMinor;
      }
    } else if (itemKind === 'expense') {
      const row = store.db
        .prepare(`SELECT id, workspace_id, pot_id, merchant, amount_minor, currency FROM expenses WHERE id = ?`)
        .get(itemId) as
        | {
            id: string;
            workspace_id: string;
            pot_id: string | null;
            merchant: string;
            amount_minor: number;
            currency: CurrencyCode;
          }
        | undefined;
      if (!row || !store.canWriteWorkspace(user.id, row.workspace_id)) {
        return reply.code(403).send({ error: 'Expense not found or write denied' });
      }
      wsId = row.workspace_id;
      parentPotId = row.pot_id;
      promotedName = row.merchant;
      itemCurrency = row.currency;
      envelopeEstimateMinor = row.amount_minor;
    } else {
      return reply.code(400).send({ error: 'Invalid itemKind' });
    }

    const parentPotRow = parentPotId
      ? (store.db.prepare(`SELECT color FROM pots WHERE id = ?`).get(parentPotId) as { color: string } | undefined)
      : undefined;
    const potColor = parentPotRow?.color || palette[Math.abs(promotedName.length) % palette.length];

    const newPotId = `pot-${crypto.randomUUID().slice(0, 8)}`;
    const childCurrency = (child.currency || itemCurrency || user.defaultCurrency) as CurrencyCode;
    let childId = '';

    store.db.exec('BEGIN IMMEDIATE;');
    try {
      store.db
        .prepare(
          `INSERT INTO pots (id, workspace_id, parent_id, name, icon, color, envelope_mode, monthly_estimate_minor, currency, tags_json, sort_order)
           VALUES (?, ?, ?, ?, 'folder', ?, ?, ?, ?, '[]', 10)`
        )
        .run(
          newPotId,
          wsId,
          parentPotId,
          promotedName,
          potColor,
          promoteMode === 'envelope' && envelopeEstimateMinor > 0 ? 1 : 0,
          promoteMode === 'envelope' ? envelopeEstimateMinor : 0,
          itemCurrency
        );

      if (promoteMode === 'envelope') {
        // Re-link any attachments onto the newly promoted pot and replace the leaf item cleanly
        store.db
          .prepare(`UPDATE attachments SET entity_type = 'pot', entity_id = ? WHERE entity_type = ? AND entity_id = ?`)
          .run(newPotId, itemKind, itemId);
        if (itemKind === 'obligation') {
          store.db.prepare(`DELETE FROM obligations WHERE id = ?`).run(itemId);
        } else {
          store.db.prepare(`DELETE FROM expenses WHERE id = ?`).run(itemId);
        }
      } else {
        // 'group' mode: move the original item inside the new pot alongside the new child
        if (itemKind === 'obligation') {
          store.db.prepare(`UPDATE obligations SET pot_id = ? WHERE id = ?`).run(newPotId, itemId);
        } else {
          store.db.prepare(`UPDATE expenses SET pot_id = ? WHERE id = ?`).run(newPotId, itemId);
        }
      }

      if (childKind === 'pot') {
        childId = `pot-${crypto.randomUUID().slice(0, 8)}`;
        store.db
          .prepare(
            `INSERT INTO pots (id, workspace_id, parent_id, name, icon, color, envelope_mode, monthly_estimate_minor, currency, tags_json, sort_order)
             VALUES (?, ?, ?, ?, 'folder', ?, ?, ?, ?, '[]', 10)`
          )
          .run(
            childId,
            wsId,
            newPotId,
            childName,
            potColor,
            childAmountMinor > 0 ? 1 : 0,
            childAmountMinor,
            childCurrency
          );
      } else if (childKind === 'obligation') {
        childId = `ob-${crypto.randomUUID().slice(0, 8)}`;
        const cad = (child.cadence || 'monthly') as ObligationRecord['cadence'];
        const nextDue = String(child.nextDueDate || new Date().toISOString().slice(0, 10));
        const dueDay = Number(nextDue.slice(8, 10)) || 1;
        const intMonths = cadenceIntervalMonths(cad, Number(child.intervalMonths || 1));
        store.db
          .prepare(
            `INSERT INTO obligations (
               id, workspace_id, pot_id, name, amount_minor, currency, cadence, interval_months,
               next_due_date, due_day, preserved_minor, auto_preserve, split_mode, wadera_split_bp,
               tags_json, manage_url, portal_url, reference_number, renewal_notice_days, notes, is_active
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, '[]', NULL, NULL, NULL, NULL, NULL, 1)`
          )
          .run(
            childId,
            wsId,
            newPotId,
            childName,
            childAmountMinor,
            childCurrency,
            cad,
            intMonths,
            nextDue,
            dueDay,
            wsId === 'ws-home' ? 'equal_50_50' : 'owner_only',
            wsId === 'ws-home' ? 5000 : 10000
          );
      } else {
        childId = `exp-${crypto.randomUUID().slice(0, 8)}`;
        const spentDate = String(child.spentDate || new Date().toISOString().slice(0, 10));
        const childAccId =
          (child as { accountId?: string | null }).accountId !== undefined
            ? (child as { accountId?: string | null }).accountId || null
            : defaultAccountForWorkspace(store, wsId, childCurrency);
        store.db
          .prepare(
            `INSERT INTO expenses (id, workspace_id, pot_id, account_id, flow_direction, merchant, description, amount_minor, currency, spent_date, tags_json, portal_url, source, items_json, created_at)
             VALUES (?, ?, ?, ?, 'outflow', ?, '', ?, ?, ?, '[]', NULL, 'manual', '[]', ?)`
          )
          .run(childId, wsId, newPotId, childAccId, childName, childAmountMinor, childCurrency, spentDate, new Date().toISOString());
        if (childAccId && childAmountMinor > 0) {
          adjustAccountBalance(store, childAccId, -childAmountMinor, childCurrency);
        }
      }

      store.db.exec('COMMIT;');
    } catch (err) {
      store.db.exec('ROLLBACK;');
      throw err;
    }

    return { ok: true, newPotId, childId, parentPotId };
  });

  app.delete('/api/pots/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db
      .prepare(`SELECT workspace_id, parent_id FROM pots WHERE id = ?`)
      .get(id) as { workspace_id: string; parent_id: string | null } | undefined;
    if (!row || !store.canWriteWorkspace(user.id, row.workspace_id)) return reply.code(403).send({ error: 'Denied' });
    // Re-parent nested children up to the deleted pot's parent so deep hierarchies stay connected
    store.db.prepare(`UPDATE pots SET parent_id = ? WHERE parent_id = ?`).run(row.parent_id, id);
    store.db.prepare(`UPDATE obligations SET pot_id = ? WHERE pot_id = ?`).run(row.parent_id, id);
    store.db.prepare(`UPDATE expenses SET pot_id = ? WHERE pot_id = ?`).run(row.parent_id, id);
    store.db.prepare(`DELETE FROM pots WHERE id = ?`).run(id);
    return { ok: true };
  });

  // --- CRUD: Scheduled Obligations & Sinking-Fund 'Preserve' ---
  app.post('/api/obligations', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const wsId = String(b.workspaceId || 'ws-home');
    if (!store.canWriteWorkspace(user.id, wsId)) return reply.code(403).send({ error: 'Write denied' });
    const id = b.id ? String(b.id) : `ob-${crypto.randomUUID().slice(0, 8)}`;
    const cadence = (b.cadence as ObligationRecord['cadence']) || 'monthly';
    const nextDueDate = String(b.nextDueDate || new Date().toISOString().slice(0, 10));
    const dueDay = Number(nextDueDate.slice(8, 10)) || 1;
    const intervalMonths = cadenceIntervalMonths(cadence, Number(b.intervalMonths || 1));
    const currency = String(b.currency || user.defaultCurrency) as CurrencyCode;

    const existingOb = b.id
      ? (store.db.prepare(`SELECT account_id, liability_id FROM obligations WHERE id = ?`).get(id) as
          | { account_id: string | null; liability_id: string | null }
          | undefined)
      : undefined;
    const accountId =
      b.accountId !== undefined
        ? b.accountId
          ? String(b.accountId)
          : null
        : existingOb !== undefined
        ? existingOb.account_id
        : defaultAccountForWorkspace(store, wsId, currency);
    const liabilityId =
      b.liabilityId !== undefined
        ? b.liabilityId
          ? String(b.liabilityId)
          : null
        : existingOb !== undefined
        ? existingOb.liability_id
        : null;

    store.db
      .prepare(
        `INSERT INTO obligations (
           id, workspace_id, pot_id, account_id, liability_id, name, amount_minor, currency, cadence, interval_months,
           next_due_date, due_day, preserved_minor, auto_preserve, split_mode, wadera_split_bp,
           tags_json, manage_url, portal_url, reference_number, renewal_notice_days, notes, is_active
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, pot_id=excluded.pot_id, account_id=excluded.account_id,
           liability_id=excluded.liability_id, name=excluded.name,
           amount_minor=excluded.amount_minor, currency=excluded.currency, cadence=excluded.cadence,
           interval_months=excluded.interval_months, next_due_date=excluded.next_due_date, due_day=excluded.due_day,
           preserved_minor=excluded.preserved_minor, auto_preserve=excluded.auto_preserve,
           split_mode=excluded.split_mode, wadera_split_bp=excluded.wadera_split_bp, tags_json=excluded.tags_json,
           manage_url=excluded.manage_url, portal_url=excluded.portal_url, reference_number=excluded.reference_number,
           renewal_notice_days=excluded.renewal_notice_days, notes=excluded.notes, is_active=excluded.is_active`
      )
      .run(
        id,
        wsId,
        b.potId ? String(b.potId) : null,
        accountId,
        liabilityId,
        String(b.name || 'Scheduled Payment'),
        Math.round(Number(b.amountMinor ?? 0)),
        currency,
        cadence,
        intervalMonths,
        nextDueDate,
        dueDay,
        Math.round(Number(b.preservedMinor ?? 0)),
        b.autoPreserve === false ? 0 : 1,
        String(b.splitMode || (wsId === 'ws-home' ? 'equal_50_50' : 'owner_only')),
        Number(b.waderaSplitBp ?? (wsId === 'ws-home' ? 5000 : 10000)),
        JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
        b.manageUrl ? String(b.manageUrl) : null,
        b.portalUrl ? String(b.portalUrl) : null,
        b.referenceNumber ? String(b.referenceNumber) : null,
        b.renewalNoticeDays != null && b.renewalNoticeDays !== '' ? Number(b.renewalNoticeDays) : null,
        b.notes ? String(b.notes) : null,
        b.isActive === false ? 0 : 1
      );

    // If caller also edited the completed occurrence timestamp, amount, or account for a specific yearMonth
    if (b.occurrenceYearMonth && (b.occurrencePaidAt || b.occurrenceActualPaidMinor != null || b.accountId !== undefined)) {
      const occYm = String(b.occurrenceYearMonth);
      const existingOcc = store.db
        .prepare(
          `SELECT id, paid_at, actual_paid_minor, currency, account_id, status FROM payment_occurrences WHERE obligation_id = ? AND year_month = ?`
        )
        .get(id, occYm) as
        | {
            id: string;
            paid_at: string | null;
            actual_paid_minor: number | null;
            currency: CurrencyCode;
            account_id: string | null;
            status: string;
          }
        | undefined;
      if (existingOcc) {
        const nextPaidAt = b.occurrencePaidAt ? String(b.occurrencePaidAt) : existingOcc.paid_at;
        const nextActual =
          b.occurrenceActualPaidMinor != null
            ? Math.round(Number(b.occurrenceActualPaidMinor))
            : existingOcc.actual_paid_minor;
        const nextAccId = b.accountId !== undefined ? accountId : existingOcc.account_id;

        if (existingOcc.status === 'paid') {
          if (existingOcc.account_id && existingOcc.actual_paid_minor) {
            adjustAccountBalance(store, existingOcc.account_id, +existingOcc.actual_paid_minor, existingOcc.currency);
          }
          if (nextAccId && nextActual) {
            adjustAccountBalance(store, nextAccId, -nextActual, currency);
          }
        }

        store.db
          .prepare(`UPDATE payment_occurrences SET paid_at = ?, actual_paid_minor = ?, account_id = ?, currency = ? WHERE id = ?`)
          .run(nextPaidAt, nextActual, nextAccId, currency, existingOcc.id);
      }
    }

    return { ok: true, id };
  });

  // Tick / Untick "[✓] Mark as Paid / Set Aside" (logs timestamped occurrence; deducts/refunds linked Bank Account live)
  app.post('/api/obligations/:id/toggle-paid', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as {
      yearMonth?: string;
      paid?: boolean;
      preserveDepositMinor?: number;
      paidAt?: string;
      accountId?: string | null;
    };
    const ym = body.yearMonth || new Date().toISOString().slice(0, 7);

    const wsIds = store.readableWorkspaceIds(user.id, 'all');
    const ob = store.listObligations(wsIds).find((o) => o.id === id);
    if (!ob || !store.canWriteWorkspace(user.id, ob.workspaceId)) {
      return reply.code(403).send({ error: 'Obligation not found or write denied' });
    }

    const metrics = computeObligationMonthMetrics(ob, ym);
    const existingOcc = store.db
      .prepare(
        `SELECT id, status, actual_paid_minor, currency, account_id, liability_id, liability_delta_minor, paid_at FROM payment_occurrences WHERE obligation_id = ? AND year_month = ?`
      )
      .get(ob.id, ym) as
      | {
          id: string;
          status: string;
          actual_paid_minor: number | null;
          currency: CurrencyCode;
          account_id: string | null;
          liability_id: string | null;
          liability_delta_minor: number;
          paid_at: string | null;
        }
      | undefined;

    const targetAccountId =
      body.accountId !== undefined
        ? body.accountId || null
        : ob.accountId ?? defaultAccountForWorkspace(store, ob.workspaceId, ob.currency);
    const targetLiabilityId = ob.liabilityId ?? null;

    const markPaid = body.preserveDepositMinor && body.preserveDepositMinor > 0 ? true : body.paid !== false;
    const nowIso = new Date().toISOString();
    const defaultDay = String(Math.min(28, Math.max(1, ob.dueDay || 1))).padStart(2, '0');
    const dueInYm = `${ym}-${defaultDay}`;
    const defaultTimestampInYm = nowIso.slice(0, 7) === ym ? nowIso : `${dueInYm}T${nowIso.slice(11, 19)}Z`;
    const paidAtIso = body.paidAt || defaultTimestampInYm;

    store.db.exec('BEGIN IMMEDIATE;');
    try {
      // First reverse any previous paid occurrence balance & liability effect for this month
      if (existingOcc && existingOcc.status === 'paid') {
        if (existingOcc.account_id && existingOcc.actual_paid_minor) {
          adjustAccountBalance(store, existingOcc.account_id, +existingOcc.actual_paid_minor, existingOcc.currency);
        }
        if (existingOcc.liability_id && existingOcc.liability_delta_minor > 0) {
          reverseLiabilityPaydown(store, existingOcc.liability_id, existingOcc.liability_delta_minor);
        }
      }

      if (markPaid) {
        if (body.accountId !== undefined) {
          store.db.prepare(`UPDATE obligations SET account_id = ? WHERE id = ?`).run(targetAccountId, ob.id);
        }

        if (!metrics.isDueThisMonth) {
          // Monthly Sinking-Fund ("Preserve") Set-Aside for a future/multi-month goal
          const sliceMinor =
            body.preserveDepositMinor && body.preserveDepositMinor > 0
              ? Math.round(body.preserveDepositMinor)
              : existingOcc?.actual_paid_minor || metrics.monthlyPreserveNativeMinor || ob.amountMinor;

          store.db
            .prepare(
              `INSERT INTO payment_occurrences (id, obligation_id, account_id, liability_id, liability_delta_minor, year_month, due_date, expected_minor, actual_paid_minor, currency, status, paid_at, notes)
               VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, 'paid', ?, 'Monthly sinking set-aside')
               ON CONFLICT(obligation_id, year_month) DO UPDATE SET
                 account_id=excluded.account_id, liability_id=NULL, liability_delta_minor=0, status='paid', actual_paid_minor=excluded.actual_paid_minor, paid_at=excluded.paid_at, notes=excluded.notes`
            )
            .run(
              `occ-${crypto.randomUUID().slice(0, 8)}`,
              ob.id,
              targetAccountId,
              ym,
              dueInYm,
              sliceMinor,
              sliceMinor,
              ob.currency,
              paidAtIso
            );

          if (!existingOcc || existingOcc.status !== 'paid') {
            const nextPreserved = Math.min(ob.amountMinor, ob.preservedMinor + sliceMinor);
            store.db.prepare(`UPDATE obligations SET preserved_minor = ? WHERE id = ?`).run(nextPreserved, ob.id);
          }

          if (targetAccountId) {
            adjustAccountBalance(store, targetAccountId, -sliceMinor, ob.currency);
          }
        } else {
          // Scheduled Bill due this month (also reduces linked Mortgage / Loan / Credit Card balance!)
          const liabDeltaMinor = applyLiabilityPaydown(
            store,
            targetLiabilityId,
            ob.amountMinor,
            ob.currency,
            true
          );

          store.db
            .prepare(
              `INSERT INTO payment_occurrences (id, obligation_id, account_id, liability_id, liability_delta_minor, year_month, due_date, expected_minor, actual_paid_minor, currency, status, paid_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)
               ON CONFLICT(obligation_id, year_month) DO UPDATE SET
                 account_id=excluded.account_id, liability_id=excluded.liability_id, liability_delta_minor=excluded.liability_delta_minor, status='paid', actual_paid_minor=excluded.actual_paid_minor, paid_at=excluded.paid_at`
            )
            .run(
              `occ-${crypto.randomUUID().slice(0, 8)}`,
              ob.id,
              targetAccountId,
              targetLiabilityId,
              liabDeltaMinor,
              ym,
              dueInYm,
              ob.amountMinor,
              ob.amountMinor,
              ob.currency,
              paidAtIso
            );

          if (targetAccountId) {
            adjustAccountBalance(store, targetAccountId, -ob.amountMinor, ob.currency);
          }

          // If this was a multi-month or one-off obligation due this month, advance nextDueDate & reset Preserve counter!
          if (ob.cadence !== 'monthly' && ob.nextDueDate.slice(0, 7) <= ym) {
            const reset = applyObligationPaymentReset(ob);
            store.db
              .prepare(`UPDATE obligations SET next_due_date = ?, preserved_minor = ?, is_active = ? WHERE id = ?`)
              .run(reset.nextDueDate, reset.preservedMinor, reset.isActive ? 1 : 0, ob.id);
          }
        }
      } else {
        // Unticking [✓] or clicking Undo in the Timeline table
        if (existingOcc && existingOcc.status === 'paid' && !metrics.isDueThisMonth) {
          const reversedPreserved = Math.max(0, ob.preservedMinor - (existingOcc.actual_paid_minor || 0));
          store.db.prepare(`UPDATE obligations SET preserved_minor = ? WHERE id = ?`).run(reversedPreserved, ob.id);
        }

        store.db
          .prepare(`DELETE FROM payment_occurrences WHERE obligation_id = ? AND year_month = ?`)
          .run(ob.id, ym);

        if (ob.cadence !== 'monthly' && ob.cadence !== 'once' && ob.nextDueDate.slice(0, 7) > ym) {
          const rolledBack = addMonthsToDate(ob.nextDueDate, -cadenceIntervalMonths(ob.cadence, ob.intervalMonths));
          if (rolledBack.slice(0, 7) === ym) {
            store.db.prepare(`UPDATE obligations SET next_due_date = ?, is_active = 1 WHERE id = ?`).run(rolledBack, ob.id);
          }
        }
      }
      store.db.exec('COMMIT;');
    } catch (err) {
      store.db.exec('ROLLBACK;');
      throw err;
    }
    return { ok: true, accountId: targetAccountId };
  });

  app.delete('/api/obligations/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db.prepare(`SELECT workspace_id FROM obligations WHERE id = ?`).get(id) as { workspace_id: string } | undefined;
    if (!row || !store.canWriteWorkspace(user.id, row.workspace_id)) return reply.code(403).send({ error: 'Denied' });
    store.db.prepare(`DELETE FROM obligations WHERE id = ?`).run(id);
    return { ok: true };
  });

  // --- CRUD: Expenses, Deposits & Itemized Receipts (with Live Bank Account Balance Sync) ---
  app.post('/api/expenses', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const wsId = String(b.workspaceId || 'ws-home');
    if (!store.canWriteWorkspace(user.id, wsId)) return reply.code(403).send({ error: 'Write denied' });
    const id = b.id ? String(b.id) : `exp-${crypto.randomUUID().slice(0, 8)}`;
    const spentDate = String(b.spentDate || new Date().toISOString().slice(0, 10));
    const currency = String(b.currency || user.defaultCurrency) as CurrencyCode;
    const amountMinor = Math.round(Number(b.amountMinor ?? 0));

    const existingExp = b.id
      ? (store.db
          .prepare(
            `SELECT id, account_id, liability_id, flow_direction, amount_minor, currency, created_at FROM expenses WHERE id = ?`
          )
          .get(id) as
          | {
              id: string;
              account_id: string | null;
              liability_id: string | null;
              flow_direction: string;
              amount_minor: number;
              currency: CurrencyCode;
              created_at: string;
            }
          | undefined)
      : undefined;

    const flowDirection: 'outflow' | 'inflow' =
      b.flowDirection === 'inflow'
        ? 'inflow'
        : b.flowDirection === 'outflow'
        ? 'outflow'
        : existingExp?.flow_direction === 'inflow'
        ? 'inflow'
        : 'outflow';

    const accountId =
      b.accountId !== undefined
        ? b.accountId
          ? String(b.accountId)
          : null
        : existingExp !== undefined
        ? existingExp.account_id
        : defaultAccountForWorkspace(store, wsId, currency);
    const liabilityId =
      b.liabilityId !== undefined
        ? b.liabilityId
          ? String(b.liabilityId)
          : null
        : existingExp !== undefined
        ? existingExp.liability_id
        : null;

    const nowIso = new Date().toISOString();
    let createdAt = existingExp?.created_at || `${spentDate}T${nowIso.slice(11, 19)}Z`;
    if (b.spentTime && /^\d{2}:\d{2}/.test(String(b.spentTime))) {
      createdAt = `${spentDate}T${String(b.spentTime).slice(0, 5)}:00Z`;
    } else if (b.createdAt) {
      createdAt = String(b.createdAt);
    }

    store.db.exec('BEGIN IMMEDIATE;');
    try {
      // 1. If editing an existing expense, reverse its previous bank account & liability balance impact
      if (existingExp && existingExp.amount_minor > 0) {
        if (existingExp.account_id) {
          const reverseDelta =
            existingExp.flow_direction === 'inflow' ? -existingExp.amount_minor : +existingExp.amount_minor;
          adjustAccountBalance(store, existingExp.account_id, reverseDelta, existingExp.currency);
        }
        if (existingExp.liability_id && existingExp.flow_direction !== 'inflow') {
          const rateMap = buildRateMap(store.getFxRates());
          const oldLiab = store.db
            .prepare(`SELECT currency FROM liabilities WHERE id = ?`)
            .get(existingExp.liability_id) as { currency: CurrencyCode } | undefined;
          if (oldLiab) {
            const revLiabMinor = convertMinor(existingExp.amount_minor, existingExp.currency, oldLiab.currency, rateMap);
            reverseLiabilityPaydown(store, existingExp.liability_id, revLiabMinor);
          }
        }
      }

      // 2. Upsert the expense / deposit row
      store.db
        .prepare(
          `INSERT INTO expenses (id, workspace_id, pot_id, account_id, liability_id, flow_direction, merchant, description, amount_minor, currency, spent_date, tags_json, portal_url, source, items_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             workspace_id=excluded.workspace_id, pot_id=excluded.pot_id, account_id=excluded.account_id,
             liability_id=excluded.liability_id, flow_direction=excluded.flow_direction, merchant=excluded.merchant,
             description=excluded.description, amount_minor=excluded.amount_minor, currency=excluded.currency,
             spent_date=excluded.spent_date, tags_json=excluded.tags_json, portal_url=excluded.portal_url,
             items_json=excluded.items_json, created_at=excluded.created_at`
        )
        .run(
          id,
          wsId,
          b.potId ? String(b.potId) : null,
          accountId,
          liabilityId,
          flowDirection,
          String(b.merchant || 'Expense'),
          String(b.description || ''),
          amountMinor,
          currency,
          spentDate,
          JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
          b.portalUrl ? String(b.portalUrl) : null,
          String(b.source || 'manual'),
          JSON.stringify(Array.isArray(b.items) ? b.items : []),
          createdAt
        );

      // 3. Apply the new bank account & liability balance impact
      if (accountId && amountMinor > 0) {
        const applyDelta = flowDirection === 'inflow' ? +amountMinor : -amountMinor;
        adjustAccountBalance(store, accountId, applyDelta, currency);
      }
      if (liabilityId && amountMinor > 0 && flowDirection !== 'inflow') {
        applyLiabilityPaydown(store, liabilityId, amountMinor, currency, false);
      }

      store.db.exec('COMMIT;');
    } catch (err) {
      store.db.exec('ROLLBACK;');
      throw err;
    }

    return { ok: true, id, accountId, flowDirection };
  });

  app.delete('/api/expenses/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db
      .prepare(`SELECT workspace_id, account_id, liability_id, flow_direction, amount_minor, currency FROM expenses WHERE id = ?`)
      .get(id) as
      | {
          workspace_id: string;
          account_id: string | null;
          liability_id: string | null;
          flow_direction: string;
          amount_minor: number;
          currency: CurrencyCode;
        }
      | undefined;
    if (!row || !store.canWriteWorkspace(user.id, row.workspace_id)) return reply.code(403).send({ error: 'Denied' });

    store.db.exec('BEGIN IMMEDIATE;');
    try {
      if (row.account_id && row.amount_minor > 0) {
        const reverseDelta = row.flow_direction === 'inflow' ? -row.amount_minor : +row.amount_minor;
        adjustAccountBalance(store, row.account_id, reverseDelta, row.currency);
      }
      if (row.liability_id && row.amount_minor > 0 && row.flow_direction !== 'inflow') {
        const rateMap = buildRateMap(store.getFxRates());
        const oldLiab = store.db
          .prepare(`SELECT currency FROM liabilities WHERE id = ?`)
          .get(row.liability_id) as { currency: CurrencyCode } | undefined;
        if (oldLiab) {
          const revLiabMinor = convertMinor(row.amount_minor, row.currency, oldLiab.currency, rateMap);
          reverseLiabilityPaydown(store, row.liability_id, revLiabMinor);
        }
      }
      store.db.prepare(`DELETE FROM expenses WHERE id = ?`).run(id);
      store.db.exec('COMMIT;');
    } catch (err) {
      store.db.exec('ROLLBACK;');
      throw err;
    }
    return { ok: true };
  });

  // --- CRUD: Wealth Assets & Belongings ---
  app.post('/api/assets', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const wsId = String(b.workspaceId || user.personalWorkspaceId);
    if (!store.canWriteWorkspace(user.id, wsId)) return reply.code(403).send({ error: 'Write denied' });
    const id = b.id ? String(b.id) : `ast-${crypto.randomUUID().slice(0, 8)}`;
    store.db
      .prepare(
        `INSERT INTO assets (
           id, workspace_id, name, asset_class, purchase_date, purchase_price_minor, current_value_minor,
           currency, curve_model, annual_rate_bp, residual_floor_minor, portal_url, manage_url, reference_number, notes, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, name=excluded.name, asset_class=excluded.asset_class,
           purchase_date=excluded.purchase_date, purchase_price_minor=excluded.purchase_price_minor,
           current_value_minor=excluded.current_value_minor, currency=excluded.currency,
           curve_model=excluded.curve_model, annual_rate_bp=excluded.annual_rate_bp,
           residual_floor_minor=excluded.residual_floor_minor, portal_url=excluded.portal_url,
           manage_url=excluded.manage_url, reference_number=excluded.reference_number,
           notes=excluded.notes, updated_at=excluded.updated_at`
      )
      .run(
        id,
        wsId,
        String(b.name || 'Belonging'),
        String(b.assetClass || 'belonging'),
        b.purchaseDate ? String(b.purchaseDate) : null,
        Math.round(Number(b.purchasePriceMinor ?? 0)),
        Math.round(Number(b.currentValueMinor ?? 0)),
        String(b.currency || user.defaultCurrency),
        String(b.curveModel || 'compound_annual'),
        Math.round(Number(b.annualRateBp ?? 0)),
        Math.round(Number(b.residualFloorMinor ?? 0)),
        b.portalUrl ? String(b.portalUrl) : null,
        b.manageUrl ? String(b.manageUrl) : null,
        b.referenceNumber ? String(b.referenceNumber) : null,
        b.notes ? String(b.notes) : null,
        new Date().toISOString()
      );
    return { ok: true, id };
  });

  app.delete('/api/assets/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db.prepare(`SELECT workspace_id FROM assets WHERE id = ?`).get(id) as { workspace_id: string } | undefined;
    if (!row || !store.canWriteWorkspace(user.id, row.workspace_id)) return reply.code(403).send({ error: 'Denied' });
    store.db.prepare(`DELETE FROM assets WHERE id = ?`).run(id);
    return { ok: true };
  });

  // --- CRUD: Liabilities ---
  app.post('/api/liabilities', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const wsId = String(b.workspaceId || 'ws-home');
    if (!store.canWriteWorkspace(user.id, wsId)) return reply.code(403).send({ error: 'Write denied' });
    const id = b.id ? String(b.id) : `liab-${crypto.randomUUID().slice(0, 8)}`;
    store.db
      .prepare(
        `INSERT INTO liabilities (
           id, workspace_id, linked_asset_id, name, kind, balance_minor, apr_bp,
           monthly_payment_minor, currency, end_date, portal_url, reference_number, notes, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, linked_asset_id=excluded.linked_asset_id, name=excluded.name,
           kind=excluded.kind, balance_minor=excluded.balance_minor, apr_bp=excluded.apr_bp,
           monthly_payment_minor=excluded.monthly_payment_minor, currency=excluded.currency,
           end_date=excluded.end_date, portal_url=excluded.portal_url, reference_number=excluded.reference_number,
           notes=excluded.notes, updated_at=excluded.updated_at`
      )
      .run(
        id,
        wsId,
        b.linkedAssetId ? String(b.linkedAssetId) : null,
        String(b.name || 'Loan'),
        String(b.kind || 'loan'),
        Math.round(Number(b.balanceMinor ?? 0)),
        Math.round(Number(b.aprBp ?? 0)),
        Math.round(Number(b.monthlyPaymentMinor ?? 0)),
        String(b.currency || user.defaultCurrency),
        b.endDate ? String(b.endDate) : null,
        b.portalUrl ? String(b.portalUrl) : null,
        b.referenceNumber ? String(b.referenceNumber) : null,
        b.notes ? String(b.notes) : null,
        new Date().toISOString()
      );
    return { ok: true, id };
  });

  app.delete('/api/liabilities/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db.prepare(`SELECT workspace_id FROM liabilities WHERE id = ?`).get(id) as { workspace_id: string } | undefined;
    if (!row || !store.canWriteWorkspace(user.id, row.workspace_id)) return reply.code(403).send({ error: 'Denied' });
    store.db.prepare(`DELETE FROM liabilities WHERE id = ?`).run(id);
    return { ok: true };
  });

  // --- CRUD: Attachments (Receipts, Invoices, Insurance PDFs & Photos) ---
  app.get('/api/attachments', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const q = (req.query || {}) as { entityType?: string; entityId?: string };
    const wsIds = store.readableWorkspaceIds(user.id, 'all');
    return { attachments: store.listAttachments(wsIds, q.entityType, q.entityId) };
  });

  app.post('/api/attachments', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;

    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'Multipart file required' });

    const fields = part.fields as Record<string, { value?: string } | undefined>;
    const workspaceId = String(fields.workspaceId?.value || 'ws-home');
    const entityType = String(fields.entityType?.value || 'obligation');
    const entityId = String(fields.entityId?.value || '');
    const label = fields.label?.value ? String(fields.label.value) : null;

    if (!entityId || !store.canWriteWorkspace(user.id, workspaceId)) {
      return reply.code(403).send({ error: 'Invalid target or write denied' });
    }

    const buf = await part.toBuffer();
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const id = `att-${crypto.randomUUID().slice(0, 8)}`;
    const ext = path.extname(part.filename || '').slice(0, 10) || '.bin';
    const storedName = `${id}-${sha256.slice(0, 12)}${ext}`;
    const fullPath = path.join(store.paths.attachmentsDir, storedName);
    fs.writeFileSync(fullPath, buf);

    store.db
      .prepare(
        `INSERT INTO attachments (id, workspace_id, entity_type, entity_id, original_name, stored_name, mime_type, size_bytes, sha256, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        workspaceId,
        entityType,
        entityId,
        part.filename || 'document',
        storedName,
        part.mimetype || 'application/octet-stream',
        buf.byteLength,
        sha256,
        label,
        new Date().toISOString()
      );

    return { ok: true, id };
  });

  app.get('/api/attachments/:id/file', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row || !store.canReadWorkspaceItems(user.id, String(row.workspace_id))) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const fullPath = path.join(store.paths.attachmentsDir, String(row.stored_name));
    if (!fs.existsSync(fullPath)) return reply.code(404).send({ error: 'File missing on disk' });
    reply.header('Content-Disposition', `inline; filename="${String(row.original_name).replace(/"/g, '')}"`);
    reply.type(String(row.mime_type || 'application/octet-stream'));
    return fs.createReadStream(fullPath);
  });

  app.delete('/api/attachments/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row || !store.canWriteWorkspace(user.id, String(row.workspace_id))) {
      return reply.code(403).send({ error: 'Denied' });
    }
    const fullPath = path.join(store.paths.attachmentsDir, String(row.stored_name));
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    store.db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id);
    return { ok: true };
  });
}

import type { ObligationRecord } from '../shared/types.js';
