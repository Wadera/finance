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
  resolveWaderaShareBp,
} from '../shared/financeEngine.js';
import type {
  CurrencyCode,
  PartnerVisibility,
  SplitMode,
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

    const workspaces = store.getWorkspaces().map((ws) => ({
      ...ws,
      canReadItems: store.canReadWorkspaceItems(user.id, ws.id),
      canWrite: store.canWriteWorkspace(user.id, ws.id),
      includedInFamilyWealth: store.canIncludeInCombinedWealth(user.id, ws.id),
    }));

    return {
      user,
      users: store.getUsers().map((u) => ({
        id: u.id,
        handle: u.handle,
        displayName: u.displayName,
        personalWorkspaceId: u.personalWorkspaceId,
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

    const q = (req.query || {}) as { ym?: string; scope?: 'all' | 'shared' | 'personal' | 'partner' };
    const ym = q.ym && /^\d{4}-\d{2}$/.test(q.ym) ? q.ym : new Date().toISOString().slice(0, 7);
    const scope = q.scope || 'all';
    const cur = user.defaultCurrency;
    const fxRates = store.getFxRates();
    const rateMap = buildRateMap(fxRates);

    const wsIds = store.readableWorkspaceIds(user.id, scope);
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
    const expenses = allSixMonthExpenses.filter((e) => e.spentDate.slice(0, 7) === ym);

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
      const preserveDisplayMinor = convertMinor(metrics.monthlyPreserveNativeMinor, ob.currency, cur, rateMap);
      const effectiveDisplayMinor = convertMinor(metrics.effectiveMonthlyBurdenNativeMinor, ob.currency, cur, rateMap);
      const targetDisplayMinor = convertMinor(ob.amountMinor, ob.currency, cur, rateMap);
      const preservedDisplayMinor = convertMinor(ob.preservedMinor, ob.currency, cur, rateMap);

      return {
        ...ob,
        metrics,
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

    const potTree = buildPotRollupTree(pots, obligations, expenses, ym, cur, rateMap);

    // Monthly Income total in display currency
    const activeIncomes = incomes
      .map((inc) => ({
        ...inc,
        monthlyDisplayMinor: computeMonthlyIncomeMinor(inc, ym, cur, rateMap),
      }))
      .filter((i) => i.monthlyDisplayMinor > 0);

    const totalIncomeMinor = activeIncomes.reduce((s, i) => s + i.monthlyDisplayMinor, 0);

    // Unassigned obligations/expenses (where potId is null)
    const unassignedExpensesMinor = expenses
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

    // Account Runway & Month-End Sufficiency Engine
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

    const remainingPaydaysIncomeMinor = activeIncomes
      .filter((i) => i.paydayDay > currentDay && todayIso.slice(0, 7) === ym)
      .reduce((s, i) => s + i.monthlyDisplayMinor, 0);

    const unallocatedEnvelopeRemainingMinor = potTree.reduce((s, n) => {
      const sumEnv = (node: (typeof potTree)[number]): number =>
        node.unallocatedEnvelopeDisplayMinor + node.children.reduce((acc, c) => acc + sumEnv(c), 0);
      return s + sumEnv(n);
    }, 0);

    const totalNeededTillMonthEndMinor =
      unpaidBillsMinor + totalPreserveSliceMinor + unallocatedEnvelopeRemainingMinor;
    const projectedEndBalanceMinor =
      runwayCashMinor + remainingPaydaysIncomeMinor - totalNeededTillMonthEndMinor;
    const shortfallMinor = Math.max(0, -projectedEndBalanceMinor);

    // Daily Runway Curve (days 1..daysInMonth)
    const dailyCurve: Array<{ day: number; balanceMinor: number; label?: string }> = [];
    let runningBal = runwayCashMinor;
    for (let d = 1; d <= daysInMonth; d++) {
      const labels: string[] = [];
      if (d > currentDay || todayIso.slice(0, 7) !== ym) {
        for (const inc of activeIncomes) {
          if (inc.paydayDay === d) {
            runningBal += inc.monthlyDisplayMinor;
            labels.push(`+${inc.name}`);
          }
        }
      }
      for (const ob of enrichedObligations) {
        if (ob.metrics.isDueThisMonth && !ob.isPaidThisMonth && ob.dueDay === d) {
          runningBal -= ob.dueDisplayMinor;
          labels.push(`-${ob.name}`);
        }
      }
      if (d === daysInMonth && totalPreserveSliceMinor > 0) {
        runningBal -= totalPreserveSliceMinor;
        labels.push('Preserve Transfers');
      }
      dailyCurve.push({
        day: d,
        balanceMinor: runningBal,
        label: labels.length ? labels.join(', ') : undefined,
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

    // 6-Month Spending & Income Context Trend
    const trend6m = sixMonths.map((mKey) => {
      const mInc = incomes.reduce((s, i) => s + computeMonthlyIncomeMinor(i, mKey, cur, rateMap), 0);
      const mExps = allSixMonthExpenses.filter((e) => e.spentDate.slice(0, 7) === mKey);
      const mTree = buildPotRollupTree(pots, obligations, mExps, mKey, cur, rateMap);
      const mSpend =
        mTree.reduce((s, n) => s + n.effectiveTotalDisplayMinor, 0) +
        mExps.filter((e) => !e.potId).reduce((s, e) => s + convertMinor(e.amountMinor, e.currency, cur, rateMap), 0);
      return {
        yearMonth: mKey,
        incomeMinor: mInc,
        spendMinor: mSpend,
        savedMinor: Math.max(0, mInc - mSpend),
      };
    });

    return {
      yearMonth: ym,
      scope,
      displayCurrency: cur,
      accounts,
      incomes: activeIncomes,
      allIncomes: incomes,
      pots,
      potTree,
      obligations: enrichedObligations,
      expenses,
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
        totalPreserveSliceMinor,
        unallocatedEnvelopeRemainingMinor,
        totalNeededTillMonthEndMinor,
        projectedEndBalanceMinor,
        shortfallMinor,
        isSufficient: projectedEndBalanceMinor >= 0,
        dailyCurve,
      },
      sankey: {
        nodes: sankeyNodes,
        links: sankeyLinks,
      },
      trend6m,
    };
  });

  // Wealth, Belongings & Long-Horizon Forecast Endpoint
  app.get('/api/wealth/overview', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;

    const q = (req.query || {}) as { horizon?: string };
    const horizonYears = Math.min(30, Math.max(3, Number(q.horizon || 10)));
    const cur = user.defaultCurrency;
    const rateMap = buildRateMap(store.getFxRates());
    const ym = new Date().toISOString().slice(0, 7);
    const currentYear = Number(ym.slice(0, 4));

    const workspaces = store.getWorkspaces();
    const partnerWs = workspaces.find((w) => w.kind === 'personal' && w.ownerUserId !== user.id) ?? null;

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
    const sharedHalfSummary = summarizeWs('ws-home', 0.5);

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

    // Combined Family Wealth (all workspaces permitted by privacy scope)
    const combinedWsIds = workspaces
      .filter((w) => store.canIncludeInCombinedWealth(user.id, w.id))
      .map((w) => w.id);

    const combinedAssets = store.listAssets(combinedWsIds);
    const combinedLiabilities = store.listLiabilities(combinedWsIds);
    const combinedAccounts = store.listAccounts(combinedWsIds);
    const combinedCashMinor = combinedAccounts.reduce(
      (s, a) => s + convertMinor(a.balanceMinor, a.currency, cur, rateMap),
      0
    );

    // Estimate monthly net family savings for long-horizon projection
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

    const myHorizonProjection = projectWealthHorizon({
      startYear: currentYear,
      horizonYears,
      assets: [
        ...personalSummary.assets,
        ...sharedHalfSummary.assets.map((a) => ({
          ...a,
          currentValueMinor: Math.round(a.currentValueMinor * 0.5),
          residualFloorMinor: Math.round(a.residualFloorMinor * 0.5),
        })),
      ],
      liabilities: [
        ...personalSummary.liabilities,
        ...sharedHalfSummary.liabilities.map((l) => ({
          ...l,
          balanceMinor: Math.round(l.balanceMinor * 0.5),
          monthlyPaymentMinor: Math.round(l.monthlyPaymentMinor * 0.5),
        })),
      ],
      bankCashDisplayMinor: personalSummary.cashMinor + sharedHalfSummary.cashMinor,
      monthlyNetSavingsDisplayMinor: Math.round(estMonthlySavings * 0.55),
      displayCurrency: cur,
      rateMap,
    });

    // Historical snapshots aggregated by date
    const rawSnaps = store.listSnapshots(combinedWsIds);
    const snapByDate = new Map<string, { date: string; netWorthMinor: number; assetsMinor: number; liabilitiesMinor: number }>();
    for (const s of rawSnaps) {
      const curEntry = snapByDate.get(s.snapshotDate) ?? {
        date: s.snapshotDate,
        netWorthMinor: 0,
        assetsMinor: 0,
        liabilitiesMinor: 0,
      };
      curEntry.netWorthMinor += convertMinor(s.netWorthGbpMinor, 'GBP', cur, rateMap);
      curEntry.assetsMinor += convertMinor(s.totalAssetsGbpMinor, 'GBP', cur, rateMap);
      curEntry.liabilitiesMinor += convertMinor(s.totalLiabilitiesGbpMinor, 'GBP', cur, rateMap);
      snapByDate.set(s.snapshotDate, curEntry);
    }

    // Visible item lists (never expose partner items unless partnerVisibility === 'readonly')
    const itemVisibleWsIds = store.readableWorkspaceIds(user.id, 'all');
    const visibleAssets = store.listAssets(itemVisibleWsIds).map((a) => ({
      ...a,
      displayValueMinor: convertMinor(a.currentValueMinor, a.currency, cur, rateMap),
      displayPurchaseMinor: convertMinor(a.purchasePriceMinor, a.currency, cur, rateMap),
    }));
    const visibleLiabilities = store.listLiabilities(itemVisibleWsIds).map((l) => ({
      ...l,
      displayBalanceMinor: convertMinor(l.balanceMinor, l.currency, cur, rateMap),
      displayMonthlyMinor: convertMinor(l.monthlyPaymentMinor, l.currency, cur, rateMap),
    }));

    return {
      displayCurrency: cur,
      horizonYears,
      myWealth: {
        totalAssetsMinor: myTotalAssetsMinor,
        totalLiabilitiesMinor: myTotalLiabilitiesMinor,
        netWorthMinor: myNetWorthMinor,
        projection: myHorizonProjection,
      },
      partnerWealth: partnerSummaryPublic,
      combinedFamilyWealth: {
        totalAssetsMinor: horizonProjection[0]?.totalAssetsMinor ?? 0,
        totalLiabilitiesMinor: horizonProjection[0]?.totalLiabilitiesMinor ?? 0,
        netWorthMinor: horizonProjection[0]?.netWorthMinor ?? 0,
        estMonthlySavingsMinor: estMonthlySavings,
        history: Array.from(snapByDate.values()).sort((a, b) => a.date.localeCompare(b.date)),
        projection: horizonProjection,
      },
      assets: visibleAssets,
      liabilities: visibleLiabilities,
      salaryHistory: store.listIncomes([user.personalWorkspaceId]),
    };
  });

  // --- CRUD: Settings ---
  app.patch('/api/settings/preferences', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const body = (req.body || {}) as {
      defaultCurrency?: CurrencyCode;
      partnerVisibility?: PartnerVisibility;
      sharedSplitMode?: SplitMode;
      waderaCustomSplitBp?: number;
      fxRates?: Array<{ currency: CurrencyCode; rateToGbp: number }>;
    };

    if (body.defaultCurrency) {
      store.updateUserDefaultCurrency(user.id, body.defaultCurrency);
    }
    if (body.partnerVisibility) {
      store.updateWorkspaceSettings(user.personalWorkspaceId, {
        partnerVisibility: body.partnerVisibility,
      });
    }
    if (body.sharedSplitMode || body.waderaCustomSplitBp != null) {
      store.updateWorkspaceSettings('ws-home', {
        defaultSplitMode: body.sharedSplitMode,
        waderaCustomSplitBp: body.waderaCustomSplitBp,
      });
    }
    if (Array.isArray(body.fxRates)) {
      for (const r of body.fxRates) {
        if (r.rateToGbp > 0) store.updateFxRate(r.currency, Number(r.rateToGbp));
      }
    }
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
           name=excluded.name, institution=excluded.institution, currency=excluded.currency,
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
    store.db
      .prepare(
        `INSERT INTO income_streams (id, workspace_id, name, source_kind, amount_minor, currency, cadence, payday_day, effective_from, effective_to, is_active, portal_url, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, source_kind=excluded.source_kind, amount_minor=excluded.amount_minor,
           currency=excluded.currency, cadence=excluded.cadence, payday_day=excluded.payday_day,
           effective_from=excluded.effective_from, effective_to=excluded.effective_to,
           is_active=excluded.is_active, portal_url=excluded.portal_url, notes=excluded.notes`
      )
      .run(
        id,
        wsId,
        String(b.name || 'Salary'),
        String(b.sourceKind || 'salary'),
        Math.round(Number(b.amountMinor ?? 0)),
        String(b.currency || user.defaultCurrency),
        String(b.cadence || 'monthly'),
        Math.min(28, Math.max(1, Number(b.paydayDay ?? 25))),
        String(b.effectiveFrom || new Date().toISOString().slice(0, 10)),
        b.effectiveTo ? String(b.effectiveTo) : null,
        b.isActive === false ? 0 : 1,
        b.portalUrl ? String(b.portalUrl) : null,
        b.notes ? String(b.notes) : null
      );
    return { ok: true, id };
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

  // --- CRUD: Hierarchical Pots ---
  app.post('/api/pots', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const wsId = String(b.workspaceId || 'ws-home');
    if (!store.canWriteWorkspace(user.id, wsId)) return reply.code(403).send({ error: 'Write denied' });
    const id = b.id ? String(b.id) : `pot-${crypto.randomUUID().slice(0, 8)}`;
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
        b.parentId ? String(b.parentId) : null,
        String(b.name || 'New Pot'),
        String(b.icon || 'folder'),
        String(b.color || '#2E6F7E'),
        b.envelopeMode ? 1 : 0,
        Math.round(Number(b.monthlyEstimateMinor ?? 0)),
        String(b.currency || user.defaultCurrency),
        JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
        Number(b.sortOrder ?? 10)
      );
    return { ok: true, id };
  });

  app.delete('/api/pots/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db.prepare(`SELECT workspace_id FROM pots WHERE id = ?`).get(id) as { workspace_id: string } | undefined;
    if (!row || !store.canWriteWorkspace(user.id, row.workspace_id)) return reply.code(403).send({ error: 'Denied' });
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

    store.db
      .prepare(
        `INSERT INTO obligations (
           id, workspace_id, pot_id, name, amount_minor, currency, cadence, interval_months,
           next_due_date, due_day, preserved_minor, auto_preserve, split_mode, wadera_split_bp,
           tags_json, manage_url, portal_url, reference_number, renewal_notice_days, notes, is_active
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, pot_id=excluded.pot_id, name=excluded.name,
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
        String(b.name || 'Scheduled Payment'),
        Math.round(Number(b.amountMinor ?? 0)),
        String(b.currency || user.defaultCurrency),
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
    return { ok: true, id };
  });

  // Tick / Untick "[✓] Mark as Paid" (resets Preserve counter & advances nextDueDate for multi-month bills)
  app.post('/api/obligations/:id/toggle-paid', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const body = (req.body || {}) as { yearMonth?: string; paid?: boolean; preserveDepositMinor?: number };
    const ym = body.yearMonth || new Date().toISOString().slice(0, 7);

    const wsIds = store.readableWorkspaceIds(user.id, 'all');
    const ob = store.listObligations(wsIds).find((o) => o.id === id);
    if (!ob || !store.canWriteWorkspace(user.id, ob.workspaceId)) {
      return reply.code(403).send({ error: 'Obligation not found or write denied' });
    }

    // Optional action: deposit monthly 'Preserve' slice into the obligation's preservedMinor pot!
    if (body.preserveDepositMinor && body.preserveDepositMinor > 0) {
      const nextPreserved = Math.min(ob.amountMinor, ob.preservedMinor + Math.round(body.preserveDepositMinor));
      store.db.prepare(`UPDATE obligations SET preserved_minor = ? WHERE id = ?`).run(nextPreserved, ob.id);
      return { ok: true, preservedMinor: nextPreserved };
    }

    const markPaid = body.paid !== false;
    if (markPaid) {
      store.db
        .prepare(
          `INSERT INTO payment_occurrences (id, obligation_id, year_month, due_date, expected_minor, actual_paid_minor, currency, status, paid_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?)
           ON CONFLICT(obligation_id, year_month) DO UPDATE SET status='paid', actual_paid_minor=excluded.actual_paid_minor, paid_at=excluded.paid_at`
        )
        .run(
          `occ-${crypto.randomUUID().slice(0, 8)}`,
          ob.id,
          ym,
          ob.nextDueDate,
          ob.amountMinor,
          ob.amountMinor,
          ob.currency,
          new Date().toISOString()
        );

      // If this was a multi-month or one-off obligation due this month, advance nextDueDate & reset Preserve counter!
      if (ob.cadence !== 'monthly' && ob.nextDueDate.slice(0, 7) <= ym) {
        const reset = applyObligationPaymentReset(ob);
        store.db
          .prepare(`UPDATE obligations SET next_due_date = ?, preserved_minor = ?, is_active = ? WHERE id = ?`)
          .run(reset.nextDueDate, reset.preservedMinor, reset.isActive ? 1 : 0, ob.id);
      }
    } else {
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
    return { ok: true };
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

  // --- CRUD: Expenses & Itemized Receipts ---
  app.post('/api/expenses', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const b = (req.body || {}) as Record<string, unknown>;
    const wsId = String(b.workspaceId || 'ws-home');
    if (!store.canWriteWorkspace(user.id, wsId)) return reply.code(403).send({ error: 'Write denied' });
    const id = b.id ? String(b.id) : `exp-${crypto.randomUUID().slice(0, 8)}`;
    store.db
      .prepare(
        `INSERT INTO expenses (id, workspace_id, pot_id, merchant, description, amount_minor, currency, spent_date, tags_json, portal_url, source, items_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id=excluded.workspace_id, pot_id=excluded.pot_id, merchant=excluded.merchant,
           description=excluded.description, amount_minor=excluded.amount_minor, currency=excluded.currency,
           spent_date=excluded.spent_date, tags_json=excluded.tags_json, portal_url=excluded.portal_url,
           items_json=excluded.items_json`
      )
      .run(
        id,
        wsId,
        b.potId ? String(b.potId) : null,
        String(b.merchant || 'Expense'),
        String(b.description || ''),
        Math.round(Number(b.amountMinor ?? 0)),
        String(b.currency || user.defaultCurrency),
        String(b.spentDate || new Date().toISOString().slice(0, 10)),
        JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
        b.portalUrl ? String(b.portalUrl) : null,
        String(b.source || 'manual'),
        JSON.stringify(Array.isArray(b.items) ? b.items : []),
        new Date().toISOString()
      );
    return { ok: true, id };
  });

  app.delete('/api/expenses/:id', async (req, reply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = store.db.prepare(`SELECT workspace_id FROM expenses WHERE id = ?`).get(id) as { workspace_id: string } | undefined;
    if (!row || !store.canWriteWorkspace(user.id, row.workspace_id)) return reply.code(403).send({ error: 'Denied' });
    store.db.prepare(`DELETE FROM expenses WHERE id = ?`).run(id);
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
