import { ChevronDown, ChevronRight, Pencil, Plus } from 'lucide-react';
import { sankey, sankeyLeft, sankeyLinkHorizontal } from 'd3-sankey';
import React, { useMemo, useState } from 'react';
import { formatDisplayValue, formatIndexedWealth } from '../shared/currency.js';
import { buildPotBreadcrumbs } from '../shared/financeEngine.js';
import type {
  BankAccountRecord,
  CurrencyCode,
  HorizonProjectionPoint,
  PotRecord,
  PotRollupNode,
  WorkspaceRecord,
} from '../shared/types.js';
import type {
  CashflowBridgeData,
  DailyCurvePoint,
  EnrichedExpense,
  EnrichedIncome,
  EnrichedObligation,
  HorizonSummary,
  QuickAddTarget,
} from './api.js';
import type { TranslationDict } from './i18n.js';

interface SankeyNodeDatum {
  id: string;
  name: string;
  color: string;
  displayMinor: number;
  nodeKind:
    | 'income'
    | 'pool'
    | 'account'
    | 'workspace'
    | 'pot'
    | 'obligation'
    | 'expense'
    | 'subitem'
    | 'envelope'
    | 'surplus'
    | 'next_needed'
    | 'other';
  canUnfold: boolean;
  isExpanded: boolean;
  accountId?: string;
  workspaceId?: string;
  potRef?: PotRollupNode;
  obRef?: EnrichedObligation;
  expRef?: EnrichedExpense;
  dashed?: boolean;
}

interface SankeyLinkDatum {
  source: string;
  target: string;
  value: number;
  dashed?: boolean;
  strokeColorOverride?: string;
}

/**
 * 1. Interactive Unlimited-Depth Unfoldable Cashflow Sankey Diagram with Smart Two-Track Payday Bridge (Overview Tab)
 * - Top Track (Solid): Previous Month Overflow -> This Month Pool -> This Month Spending Pots (unfoldable to unlimited depth) + Buffer.
 * - Bottom Track (Dotted until ticked on Timeline): Upcoming Salary (e.g. 27th) -> Next-Cycle Bridge -> Next Month Needed Before Salary (Dotted Red, unfoldable!) + Free Savings.
 * - Never merges previous-month overflow + upcoming 27th salary into a fake 2x spendable pool.
 */
export const CashflowSankeyChart: React.FC<{
  incomes: EnrichedIncome[];
  accounts?: BankAccountRecord[];
  workspaces?: WorkspaceRecord[];
  showRoutingLayers?: boolean;
  cashflowBridge?: CashflowBridgeData;
  potTree: PotRollupNode[];
  obligations: EnrichedObligation[];
  expenses: EnrichedExpense[];
  totalIncomeMinor: number;
  potPlannedTotalMinor: number;
  netMonthlySurplusMinor: number;
  currency: CurrencyCode;
  privacyMode: boolean;
  expandedPotIds: Set<string>;
  expandedExpenseIds: Set<string>;
  onTogglePot: (potId: string) => void;
  onToggleExpense: (expId: string) => void;
  onQuickAdd: (target: QuickAddTarget) => void;
  onInspectItem?: (kind: 'pot' | 'obligation' | 'expense' | 'account', id: string) => void;
  t: TranslationDict;
}> = ({
  incomes,
  accounts = [],
  workspaces = [],
  showRoutingLayers = true,
  cashflowBridge,
  potTree,
  obligations,
  expenses,
  totalIncomeMinor,
  potPlannedTotalMinor,
  netMonthlySurplusMinor,
  currency,
  privacyMode,
  expandedPotIds,
  expandedExpenseIds,
  onTogglePot,
  onToggleExpense,
  onQuickAdd,
  onInspectItem,
  t,
}) => {
  const model = useMemo(() => {
    const nodes: SankeyNodeDatum[] = [];
    const links: SankeyLinkDatum[] = [];

    if (totalIncomeMinor <= 0 && potPlannedTotalMinor <= 0 && potTree.length === 0) {
      return null;
    }

    const obsByPot = new Map<string | null, EnrichedObligation[]>();
    for (const ob of obligations) {
      if (!ob.isActive) continue;
      const k = ob.potId ?? null;
      const list = obsByPot.get(k) ?? [];
      list.push(ob);
      obsByPot.set(k, list);
    }

    const expsByPot = new Map<string | null, EnrichedExpense[]>();
    for (const exp of expenses) {
      const k = exp.potId ?? null;
      const list = expsByPot.get(k) ?? [];
      list.push(exp);
      expsByPot.set(k, list);
    }

    // --- UNIFIED SINGLE SANKEY:
    // Left (Inflows combining into single Monthly Pool):
    //   1. Previous Month Overflow (Solid Green)
    //   2. Upcoming Salary (Dashed Green until ticked received on Timeline; Solid Green once ticked)
    // Middle:
    //   Single Monthly Pool
    // Right (Spreading out from Monthly Pool):
    //   1. This Month Spending Pots (Solid, click-to-unfoldable to unlimited depth)
    //   2. Next Month Needed Before Salary (Dashed Red, click-to-unfoldable into next month's pre-salary pots)
    //   3. Unallocated Savings / Buffer (what remains after BOTH this month's spending AND next month's pre-salary reserve)
    const poolId = 'pool-budget';
    const overflowMinor = cashflowBridge ? cashflowBridge.overflowInMinor : 0;
    const upcomingMinor = cashflowBridge ? cashflowBridge.upcomingSalaryTotalMinor : totalIncomeMinor;
    const nextNeededMinor = cashflowBridge ? cashflowBridge.nextMonthPreSalaryMinor : 0;

    const totalInflowMinor = overflowMinor + upcomingMinor;
    const totalOutflowCommitmentsMinor = potPlannedTotalMinor + nextNeededMinor;
    const poolMinor = Math.max(totalInflowMinor, totalOutflowCommitmentsMinor);

    nodes.push({
      id: poolId,
      name: t.sankeyPool,
      color: '#1E293B',
      displayMinor: poolMinor,
      nodeKind: 'pool',
      canUnfold: false,
      isExpanded: false,
    });

    if (overflowMinor > 0) {
      const ovfId = 'inc-prev-overflow';
      nodes.push({
        id: ovfId,
        name: t.sankeyPrevOverflow,
        color: '#15803D',
        displayMinor: overflowMinor,
        nodeKind: 'income',
        canUnfold: false,
        isExpanded: false,
        dashed: false,
      });
      links.push({
        source: ovfId,
        target: poolId,
        value: Math.max(1, overflowMinor),
        dashed: false,
        strokeColorOverride: '#16A34A',
      });
    }

    for (const inc of incomes) {
      if (inc.monthlyDisplayMinor <= 0) continue;
      if (cashflowBridge && inc.paydayDay < 12 && inc.isReceivedThisMonth) continue;
      const nid = `inc-upcoming-${inc.id}`;
      const pending = !inc.isReceivedThisMonth;
      nodes.push({
        id: nid,
        name: `${pending ? '' : '✓ '}${t.sankeyUpcomingSalary}: ${inc.name} (${inc.paydayDay}.)`,
        color: pending ? '#16A34A' : '#15803D',
        displayMinor: inc.monthlyDisplayMinor,
        nodeKind: 'income',
        canUnfold: false,
        isExpanded: false,
        dashed: pending,
      });
      links.push({
        source: nid,
        target: poolId,
        value: Math.max(1, inc.monthlyDisplayMinor),
        dashed: pending,
        strokeColorOverride: '#16A34A',
      });
    }

    if (totalInflowMinor < totalOutflowCommitmentsMinor) {
      const gap = totalOutflowCommitmentsMinor - totalInflowMinor;
      nodes.push({
        id: 'inc-drawdown',
        name: t.sankeyDrawdown,
        color: '#D97706',
        displayMinor: gap,
        nodeKind: 'other',
        canUnfold: false,
        isExpanded: false,
      });
      links.push({ source: 'inc-drawdown', target: poolId, value: Math.max(1, gap) });
    } else if (totalInflowMinor === 0 && potTree.length > 0) {
      nodes.push({
        id: 'inc-placeholder',
        name: t.sankeyPrevOverflow,
        color: '#94A3B8',
        displayMinor: 0,
        nodeKind: 'income',
        canUnfold: false,
        isExpanded: false,
      });
      links.push({ source: 'inc-placeholder', target: poolId, value: 1 });
    }

    const visitedPots = new Set<string>();

    const emitPotSubtree = (potNode: PotRollupNode, parentSourceId: string) => {
      const pid = potNode.pot.id;
      if (visitedPots.has(pid)) return;
      visitedPots.add(pid);

      const directObs = (obsByPot.get(pid) ?? []).filter((o) => o.effectiveDisplayMinor > 0);
      const directExps = (expsByPot.get(pid) ?? []).filter((e) => e.displayAmountMinor > 0);
      const hasChildrenToUnfold =
        potNode.children.length > 0 || directObs.length > 0 || directExps.length > 0;
      const isExpanded = hasChildrenToUnfold && expandedPotIds.has(pid);

      const nodeId = `pot-${pid}`;
      const valMinor = potNode.effectiveTotalDisplayMinor;
      const isZeroContainer = valMinor <= 0;

      nodes.push({
        id: nodeId,
        name: potNode.pot.name,
        color: potNode.pot.color || '#2E6F7E',
        displayMinor: valMinor,
        nodeKind: 'pot',
        canUnfold: hasChildrenToUnfold,
        isExpanded,
        potRef: potNode,
        dashed: isZeroContainer,
      });

      links.push({
        source: parentSourceId,
        target: nodeId,
        value: Math.max(1, valMinor),
        dashed: isZeroContainer,
      });

      if (!isExpanded) return;

      // 1. Recursive Child Sub-Pots (unlimited depth)
      for (const childNode of potNode.children) {
        emitPotSubtree(childNode, nodeId);
      }

      // 2. Direct Scheduled Obligations on this pot (each can be promoted into a Pot via '+')
      for (const ob of directObs) {
        const obNodeId = `ob-${ob.id}`;
        nodes.push({
          id: obNodeId,
          name: ob.name,
          color: potNode.pot.color || '#475569',
          displayMinor: ob.effectiveDisplayMinor,
          nodeKind: 'obligation',
          canUnfold: false,
          isExpanded: false,
          obRef: ob,
        });
        links.push({
          source: nodeId,
          target: obNodeId,
          value: Math.max(1, ob.effectiveDisplayMinor),
        });
      }

      // 3. Direct Logged Expenses on this pot (can unfold receipt line-items OR promote into a Pot via '+')
      for (const exp of directExps) {
        const expNodeId = `exp-${exp.id}`;
        const canExpUnfold = exp.items.length > 0;
        const expExpanded = canExpUnfold && expandedExpenseIds.has(exp.id);
        nodes.push({
          id: expNodeId,
          name: exp.merchant,
          color: potNode.pot.color || '#0F766E',
          displayMinor: exp.displayAmountMinor,
          nodeKind: 'expense',
          canUnfold: canExpUnfold,
          isExpanded: expExpanded,
          expRef: exp,
        });
        links.push({
          source: nodeId,
          target: expNodeId,
          value: Math.max(1, exp.displayAmountMinor),
        });

        if (expExpanded) {
          exp.items.forEach((sub, idx) => {
            const subId = `sub-${exp.id}-${idx}`;
            const subRatio = exp.amountMinor > 0 ? sub.amountMinor / exp.amountMinor : 0;
            const subDisplay = Math.round(exp.displayAmountMinor * subRatio);
            nodes.push({
              id: subId,
              name: sub.subCategory ? `${sub.name} (${sub.subCategory})` : sub.name,
              color: potNode.pot.color || '#64748B',
              displayMinor: subDisplay,
              nodeKind: 'subitem',
              canUnfold: false,
              isExpanded: false,
            });
            links.push({
              source: expNodeId,
              target: subId,
              value: Math.max(1, subDisplay),
            });
          });
        }
      }

      // 4. Remaining Unallocated Rough Envelope (keeps parent ribbon 100% proportional)
      if (potNode.unallocatedEnvelopeDisplayMinor > 0) {
        const envId = `env-${pid}`;
        nodes.push({
          id: envId,
          name: t.sankeyRemainingEnv,
          color: '#94A3B8',
          displayMinor: potNode.unallocatedEnvelopeDisplayMinor,
          nodeKind: 'envelope',
          canUnfold: false,
          isExpanded: false,
          dashed: true,
        });
        links.push({
          source: nodeId,
          target: envId,
          value: Math.max(1, potNode.unallocatedEnvelopeDisplayMinor),
          dashed: true,
        });
      }
    };

    const unassignedObs = (obsByPot.get(null) ?? []).filter((o) => o.effectiveDisplayMinor > 0);
    const unassignedExps = (expsByPot.get(null) ?? []).filter((e) => e.displayAmountMinor > 0);

    if (showRoutingLayers && accounts.length > 0) {
      // --- MULTI-LAYER ARCHITECTURE:
      // Inflows -> Monthly Pool -> Bank Accounts -> Workspace Scopes (Shared Household / Private / Polish Flat) -> Top-Level Pots -> Sub-Pots & Items
      const accMap = new Map(accounts.map((a) => [a.id, a]));
      const wsMap = new Map(workspaces.map((w) => [w.id, w]));

      const defaultAccForWs = (wsId: string): string => {
        const match =
          accounts.find((a) => a.workspaceId === wsId && a.isPrimaryRunway) ||
          accounts.find((a) => a.workspaceId === wsId) ||
          accounts[0];
        return match ? match.id : 'acc-unassigned';
      };

      // Collect all pot IDs inside a rootPot subtree
      const collectSubtreeIds = (pn: PotRollupNode): string[] => [
        pn.pot.id,
        ...pn.children.flatMap((c) => collectSubtreeIds(c)),
      ];

      // Compute how each rootPot is funded by Bank Accounts
      const accTotals = new Map<string, number>();
      const accToWsTotals = new Map<string, number>(); // `${accId}|${wsId}` -> minor
      const wsTotals = new Map<string, number>();

      for (const rootPot of potTree) {
        const wsId = rootPot.pot.workspaceId;
        const val = rootPot.effectiveTotalDisplayMinor;
        if (val <= 0) continue;
        wsTotals.set(wsId, (wsTotals.get(wsId) ?? 0) + val);

        const subtreeIds = collectSubtreeIds(rootPot);
        const byAcc = new Map<string, number>();
        let itemizedSum = 0;
        for (const pid of subtreeIds) {
          for (const ob of obsByPot.get(pid) ?? []) {
            if (ob.effectiveDisplayMinor <= 0) continue;
            const aid = ob.accountId && accMap.has(ob.accountId) ? ob.accountId : defaultAccForWs(wsId);
            byAcc.set(aid, (byAcc.get(aid) ?? 0) + ob.effectiveDisplayMinor);
            itemizedSum += ob.effectiveDisplayMinor;
          }
          for (const exp of expsByPot.get(pid) ?? []) {
            if (exp.displayAmountMinor <= 0) continue;
            const aid = exp.accountId && accMap.has(exp.accountId) ? exp.accountId : defaultAccForWs(wsId);
            byAcc.set(aid, (byAcc.get(aid) ?? 0) + exp.displayAmountMinor);
            itemizedSum += exp.displayAmountMinor;
          }
        }

        if (itemizedSum < val) {
          const rem = val - itemizedSum;
          const aid = defaultAccForWs(wsId);
          byAcc.set(aid, (byAcc.get(aid) ?? 0) + rem);
        }

        for (const [aid, amt] of byAcc.entries()) {
          accTotals.set(aid, (accTotals.get(aid) ?? 0) + amt);
          const pairKey = `${aid}|${wsId}`;
          accToWsTotals.set(pairKey, (accToWsTotals.get(pairKey) ?? 0) + amt);
        }
      }

      // Include unassigned obligations/expenses in Account -> Workspace routing
      for (const ob of unassignedObs) {
        const wsId = ob.workspaceId;
        const aid = ob.accountId && accMap.has(ob.accountId) ? ob.accountId : defaultAccForWs(wsId);
        accTotals.set(aid, (accTotals.get(aid) ?? 0) + ob.effectiveDisplayMinor);
        wsTotals.set(wsId, (wsTotals.get(wsId) ?? 0) + ob.effectiveDisplayMinor);
        const pairKey = `${aid}|${wsId}`;
        accToWsTotals.set(pairKey, (accToWsTotals.get(pairKey) ?? 0) + ob.effectiveDisplayMinor);
      }
      for (const exp of unassignedExps) {
        const wsId = exp.workspaceId;
        const aid = exp.accountId && accMap.has(exp.accountId) ? exp.accountId : defaultAccForWs(wsId);
        accTotals.set(aid, (accTotals.get(aid) ?? 0) + exp.displayAmountMinor);
        wsTotals.set(wsId, (wsTotals.get(wsId) ?? 0) + exp.displayAmountMinor);
        const pairKey = `${aid}|${wsId}`;
        accToWsTotals.set(pairKey, (accToWsTotals.get(pairKey) ?? 0) + exp.displayAmountMinor);
      }

      const accPalette: Record<string, string> = {
        'acc-club-lloyds': '#1D4ED8',
        'acc-lloyds-classic': '#0F766E',
        'acc-revolut-joint': '#7C3AED',
        'acc-revolut-personal': '#2563EB',
        'acc-alior-pln': '#B45309',
        'acc-standard-saver': '#059669',
      };

      // Emit Stage 2: Bank Account Nodes
      for (const [aid, totalAmt] of Array.from(accTotals.entries()).sort((a, b) => b[1] - a[1])) {
        if (totalAmt <= 0) continue;
        const acc = accMap.get(aid);
        const accNodeId = `acc-node-${aid}`;
        const shortName = acc
          ? acc.name.replace(/\s*\([^)]*\)/g, '')
          : 'Unassigned Account';
        nodes.push({
          id: accNodeId,
          name: `🏦 ${shortName}`,
          color: accPalette[aid] || '#0284C7',
          displayMinor: totalAmt,
          nodeKind: 'account',
          accountId: aid,
          canUnfold: false,
          isExpanded: false,
        });
        links.push({
          source: poolId,
          target: accNodeId,
          value: Math.max(1, totalAmt),
          strokeColorOverride: accPalette[aid] || '#0284C7',
        });
      }

      // Emit Stage 3: Workspace Mixing Nodes (Shared Household vs. Wadera Personal vs. Polish Flat)
      const wsMeta = (wsId: string): { label: string; color: string } => {
        const w = wsMap.get(wsId);
        if (wsId === 'ws-home' || w?.kind === 'shared') {
          return { label: `🏠 ${w?.name || 'Shared Household'}`, color: '#0F766E' };
        }
        if (wsId === 'ws-wadera') {
          return { label: `👤 ${w?.name || 'Wadera Personal'}`, color: '#3B82F6' };
        }
        if (wsId.includes('polish') || w?.kind === 'company') {
          return { label: `🇵🇱 ${w?.name || 'Polish Flat'}`, color: '#D97706' };
        }
        return { label: `📁 ${w?.name || wsId}`, color: '#475569' };
      };

      for (const [wsId, wsAmt] of Array.from(wsTotals.entries()).sort((a, b) => b[1] - a[1])) {
        if (wsAmt <= 0) continue;
        const wsNodeId = `ws-node-${wsId}`;
        const meta = wsMeta(wsId);
        nodes.push({
          id: wsNodeId,
          name: meta.label,
          color: meta.color,
          displayMinor: wsAmt,
          nodeKind: 'workspace',
          workspaceId: wsId,
          canUnfold: false,
          isExpanded: false,
        });
      }

      // Connect Stage 2 (Bank Accounts) -> Stage 3 (Workspace Scopes)
      for (const [pairKey, pairAmt] of accToWsTotals.entries()) {
        if (pairAmt <= 0) continue;
        const [aid, wsId] = pairKey.split('|');
        const meta = wsMeta(wsId);
        links.push({
          source: `acc-node-${aid}`,
          target: `ws-node-${wsId}`,
          value: Math.max(1, pairAmt),
          strokeColorOverride: meta.color,
        });
      }

      // Connect Stage 3 (Workspace Scopes) -> Stage 4+ (Top-Level Pots & Unassigned Items)
      for (const rootPot of potTree) {
        const wsNodeId = `ws-node-${rootPot.pot.workspaceId}`;
        if (!wsTotals.has(rootPot.pot.workspaceId)) continue;
        emitPotSubtree(rootPot, wsNodeId);
      }

      for (const ob of unassignedObs) {
        const obNodeId = `ob-${ob.id}`;
        const parentWsNode = wsTotals.has(ob.workspaceId) ? `ws-node-${ob.workspaceId}` : poolId;
        nodes.push({
          id: obNodeId,
          name: ob.name,
          color: '#64748B',
          displayMinor: ob.effectiveDisplayMinor,
          nodeKind: 'obligation',
          canUnfold: false,
          isExpanded: false,
          obRef: ob,
        });
        links.push({ source: parentWsNode, target: obNodeId, value: Math.max(1, ob.effectiveDisplayMinor) });
      }
      for (const exp of unassignedExps) {
        const expNodeId = `exp-${exp.id}`;
        const parentWsNode = wsTotals.has(exp.workspaceId) ? `ws-node-${exp.workspaceId}` : poolId;
        nodes.push({
          id: expNodeId,
          name: exp.merchant,
          color: '#64748B',
          displayMinor: exp.displayAmountMinor,
          nodeKind: 'expense',
          canUnfold: exp.items.length > 0,
          isExpanded: false,
          expRef: exp,
        });
        links.push({ source: parentWsNode, target: expNodeId, value: Math.max(1, exp.displayAmountMinor) });
      }
    } else {
      for (const rootPot of potTree) {
        emitPotSubtree(rootPot, poolId);
      }

      for (const ob of unassignedObs) {
        const obNodeId = `ob-${ob.id}`;
        nodes.push({
          id: obNodeId,
          name: ob.name,
          color: '#64748B',
          displayMinor: ob.effectiveDisplayMinor,
          nodeKind: 'obligation',
          canUnfold: false,
          isExpanded: false,
          obRef: ob,
        });
        links.push({ source: poolId, target: obNodeId, value: Math.max(1, ob.effectiveDisplayMinor) });
      }
      for (const exp of unassignedExps) {
        const expNodeId = `exp-${exp.id}`;
        nodes.push({
          id: expNodeId,
          name: exp.merchant,
          color: '#64748B',
          displayMinor: exp.displayAmountMinor,
          nodeKind: 'expense',
          canUnfold: exp.items.length > 0,
          isExpanded: false,
          expRef: exp,
        });
        links.push({ source: poolId, target: expNodeId, value: Math.max(1, exp.displayAmountMinor) });
      }
    }

    // Next Month Needed Before Salary (Dashed Red outflow from the same unified central pool, click-to-unfoldable!)
    if (cashflowBridge && cashflowBridge.nextMonthPreSalaryMinor > 0) {
      const nextNeedId = 'out-next-month-needed';
      const canUnfoldNext = cashflowBridge.nextMonthBreakdown.length > 0;
      const isNextExpanded = canUnfoldNext && expandedPotIds.has('__next_month_needed__');

      nodes.push({
        id: nextNeedId,
        name: `${t.sankeyNextMonthNeeded} (1–${Math.max(1, cashflowBridge.primaryPaydayDay - 1)}.)`,
        color: '#DC2626',
        displayMinor: cashflowBridge.nextMonthPreSalaryMinor,
        nodeKind: 'next_needed',
        canUnfold: canUnfoldNext,
        isExpanded: isNextExpanded,
        dashed: true,
      });
      links.push({
        source: poolId,
        target: nextNeedId,
        value: Math.max(1, cashflowBridge.nextMonthPreSalaryMinor),
        dashed: true,
        strokeColorOverride: '#DC2626',
      });

      if (isNextExpanded) {
        for (const item of cashflowBridge.nextMonthBreakdown) {
          nodes.push({
            id: item.id,
            name: item.name,
            color: item.color || '#DC2626',
            displayMinor: item.displayMinor,
            nodeKind: 'other',
            canUnfold: false,
            isExpanded: false,
            dashed: true,
          });
          links.push({
            source: nextNeedId,
            target: item.id,
            value: Math.max(1, item.displayMinor),
            dashed: true,
            strokeColorOverride: '#DC2626',
          });
        }
      }
    }

    // True Remaining Buffer / Unallocated Savings (after BOTH this month's spending AND next month's pre-salary reserve)
    const combinedFreeBufferMinor = Math.max(0, totalInflowMinor - totalOutflowCommitmentsMinor);
    if (combinedFreeBufferMinor > 0) {
      const anyPending = cashflowBridge ? cashflowBridge.upcomingSalaryPendingMinor > 0 : false;
      nodes.push({
        id: 'out-surplus',
        name: t.sankeySurplus,
        color: '#10B981',
        displayMinor: combinedFreeBufferMinor,
        nodeKind: 'surplus',
        canUnfold: false,
        isExpanded: false,
        dashed: anyPending,
      });
      links.push({
        source: poolId,
        target: 'out-surplus',
        value: Math.max(1, combinedFreeBufferMinor),
        dashed: anyPending,
        strokeColorOverride: '#10B981',
      });
    }

    if (nodes.length < 2 || links.length === 0) return null;

    // Pre-pass to determine column depth & max nodes in any column for collision-free sizing
    const probeLayout = sankey<SankeyNodeDatum, SankeyLinkDatum>()
      .nodeId((d) => d.id)
      .nodeAlign(sankeyLeft)
      .nodeWidth(10)
      .nodePadding(28)
      .extent([
        [10, 16],
        [660, 280],
      ]);

    const probed = probeLayout({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });

    const colCounts = new Map<number, number>();
    let maxDepth = 2;
    for (const nd of probed.nodes) {
      const d = nd.depth ?? 0;
      maxDepth = Math.max(maxDepth, d);
      colCounts.set(d, (colCounts.get(d) ?? 0) + 1);
    }
    const maxNodesInCol = Math.max(3, ...Array.from(colCounts.values()));
    const numCols = maxDepth + 1;

    const width = numCols <= 3 ? 900 : Math.max(900, numCols * 265 + 130);
    const height = Math.max(320, maxNodesInCol * 46 + 40);
    const rightMargin = 245;

    const finalLayout = sankey<SankeyNodeDatum, SankeyLinkDatum>()
      .nodeId((d) => d.id)
      .nodeAlign(sankeyLeft)
      .nodeWidth(10)
      .nodePadding(28)
      .extent([
        [12, 18],
        [width - rightMargin, height - 18],
      ]);

    const graph = finalLayout({
      nodes: nodes.map((n) => ({ ...n })),
      links: links.map((l) => ({ ...l })),
    });

    return { graph, width, height, numCols, maxDepth, poolMinor };
  }, [
    incomes,
    accounts,
    workspaces,
    showRoutingLayers,
    cashflowBridge,
    potTree,
    obligations,
    expenses,
    totalIncomeMinor,
    potPlannedTotalMinor,
    netMonthlySurplusMinor,
    expandedPotIds,
    expandedExpenseIds,
    t,
  ]);

  if (!model) {
    return (
      <div className="h-52 flex items-center justify-center text-sm text-slate-400 font-mono-num">
        {t.sankeyEmpty}
      </div>
    );
  }

  const { graph, width, height, numCols, maxDepth, poolMinor } = model;
  const pathGen = sankeyLinkHorizontal();
  const denom = Math.max(1, poolMinor);

  const triggerQuickAddForNode = (node: SankeyNodeDatum) => {
    if (node.nodeKind === 'pot' && node.potRef) {
      onQuickAdd({
        targetKind: 'pot',
        potId: node.potRef.pot.id,
        potName: node.potRef.pot.name,
        workspaceId: node.potRef.pot.workspaceId,
        currency: node.potRef.pot.currency,
        color: node.potRef.pot.color,
      });
    } else if (node.nodeKind === 'obligation' && node.obRef) {
      onQuickAdd({
        targetKind: 'obligation',
        itemId: node.obRef.id,
        itemName: node.obRef.name,
        workspaceId: node.obRef.workspaceId,
        parentPotId: node.obRef.potId,
        amountMinor: node.obRef.amountMinor,
        currency: node.obRef.currency,
      });
    } else if (node.nodeKind === 'expense' && node.expRef) {
      onQuickAdd({
        targetKind: 'expense',
        itemId: node.expRef.id,
        itemName: node.expRef.merchant,
        workspaceId: node.expRef.workspaceId,
        parentPotId: node.expRef.potId,
        amountMinor: node.expRef.amountMinor,
        currency: node.expRef.currency,
      });
    }
  };

  const handleNodeLabelClick = (node: SankeyNodeDatum) => {
    if (node.nodeKind === 'next_needed' && node.canUnfold) {
      onTogglePot('__next_month_needed__');
    } else if (node.nodeKind === 'account' && node.accountId && onInspectItem) {
      onInspectItem('account', node.accountId);
    } else if (node.nodeKind === 'pot' && node.potRef) {
      if (node.canUnfold) {
        onTogglePot(node.potRef.pot.id);
      } else {
        // Clicking an empty leaf pot opens Quick Add directly so user can start nesting inside it!
        triggerQuickAddForNode(node);
      }
    } else if (node.nodeKind === 'expense' && node.expRef) {
      if (node.canUnfold) {
        onToggleExpense(node.expRef.id);
      } else if (onInspectItem) {
        onInspectItem('expense', node.expRef.id);
      }
    } else if (node.nodeKind === 'obligation' && node.obRef && onInspectItem) {
      onInspectItem('obligation', node.obRef.id);
    }
  };

  return (
    <div className="w-full overflow-x-auto pb-1">
      <div
        className="relative select-none"
        style={{
          minWidth: numCols > 3 ? `${width}px` : undefined,
        }}
      >
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block overflow-visible">
          <g fill="none">
            {graph.links.map((link, idx) => {
              const d = pathGen(link as never) || '';
              const srcNode = link.source as SankeyNodeDatum;
              const tgtNode = link.target as SankeyNodeDatum;
              const customStroke = (link as SankeyLinkDatum).strokeColorOverride;
              const strokeColor =
                customStroke ||
                (tgtNode.color && tgtNode.color !== '#334155' && tgtNode.color !== '#1E293B'
                  ? tgtNode.color
                  : srcNode.color || '#64748B');
              const isDashed = Boolean((link as SankeyLinkDatum).dashed);
              const linkWidth = Math.max(2, link.width || 2);

              if (!isDashed) {
                return (
                  <path
                    key={idx}
                    d={d}
                    stroke={strokeColor}
                    strokeOpacity={0.26}
                    strokeLinecap="butt"
                    strokeWidth={linkWidth}
                    className="transition-opacity hover:stroke-opacity-50"
                  />
                );
              }

              // Solid, brighter background ribbon + crisp dotted top & bottom border curves
              const x0 = (srcNode as { x1?: number }).x1 ?? 0;
              const x1 = (tgtNode as { x0?: number }).x0 ?? 0;
              const xi = (x0 + x1) / 2;
              const y0 = link.y0 ?? 0;
              const y1 = link.y1 ?? 0;
              const halfW = linkWidth / 2;
              const topEdgeD = `M ${x0.toFixed(1)},${(y0 - halfW).toFixed(1)} C ${xi.toFixed(1)},${(y0 - halfW).toFixed(1)} ${xi.toFixed(1)},${(y1 - halfW).toFixed(1)} ${x1.toFixed(1)},${(y1 - halfW).toFixed(1)}`;
              const botEdgeD = `M ${x0.toFixed(1)},${(y0 + halfW).toFixed(1)} C ${xi.toFixed(1)},${(y0 + halfW).toFixed(1)} ${xi.toFixed(1)},${(y1 + halfW).toFixed(1)} ${x1.toFixed(1)},${(y1 + halfW).toFixed(1)}`;

              return (
                <g key={idx}>
                  <path
                    d={d}
                    stroke={strokeColor}
                    strokeOpacity={0.14}
                    strokeLinecap="butt"
                    strokeWidth={linkWidth}
                    className="transition-opacity hover:stroke-opacity-30"
                  />
                  <path
                    d={topEdgeD}
                    stroke={strokeColor}
                    strokeOpacity={0.78}
                    strokeWidth={1.6}
                    strokeDasharray="4 4"
                    strokeLinecap="round"
                  />
                  {linkWidth >= 5 && (
                    <path
                      d={botEdgeD}
                      stroke={strokeColor}
                      strokeOpacity={0.78}
                      strokeWidth={1.6}
                      strokeDasharray="4 4"
                      strokeLinecap="round"
                    />
                  )}
                </g>
              );
            })}
          </g>
          <g>
            {graph.nodes.map((node) => {
              const x0 = node.x0 ?? 0;
              const x1 = node.x1 ?? 0;
              const y0 = node.y0 ?? 0;
              const y1 = node.y1 ?? 0;
              const interactive =
                node.nodeKind === 'pot' ||
                node.nodeKind === 'obligation' ||
                node.nodeKind === 'expense' ||
                node.nodeKind === 'next_needed';
              return (
                <rect
                  key={node.id}
                  x={x0}
                  y={y0}
                  width={Math.max(7, x1 - x0)}
                  height={Math.max(5, y1 - y0)}
                  rx={2}
                  fill={node.color || '#334155'}
                  fillOpacity={node.dashed ? 0.28 : 1}
                  stroke={node.dashed ? node.color || '#334155' : undefined}
                  strokeWidth={node.dashed ? 1.5 : undefined}
                  strokeDasharray={node.dashed ? '3 2' : undefined}
                  onClick={() => interactive && handleNodeLabelClick(node)}
                  className={interactive ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}
                />
              );
            })}
          </g>
        </svg>

        {/* Precision HTML Label + Unfold Chevron + Quick '+' Overlay anchored to exact viewBox % */}
        <div className="pointer-events-none absolute inset-0">
          {graph.nodes.map((node) => {
            const x1 = node.x1 ?? 0;
            const y0 = node.y0 ?? 0;
            const y1 = node.y1 ?? 0;
            const cy = (y0 + y1) / 2;
            const depth = node.depth ?? 0;
            const pctVal = denom > 0 ? ((node.displayMinor / denom) * 100).toFixed(0) : '0';
            const valueText = privacyMode
              ? `${pctVal}%`
              : `${formatDisplayValue(node.displayMinor, { currency, privacyMode: false, compact: true })} · ${pctVal}%`;

            const canAddInside =
              node.nodeKind === 'pot' || node.nodeKind === 'obligation' || node.nodeKind === 'expense';
            const isClickableLabel =
              canAddInside ||
              node.nodeKind === 'next_needed' ||
              (node.nodeKind === 'expense' && node.canUnfold);

            const colMaxWidthPx = depth >= maxDepth ? 230 : 195;

            return (
              <div
                key={`lbl-${node.id}`}
                style={{
                  left: `${((x1 + 7) / width) * 100}%`,
                  top: `${(cy / height) * 100}%`,
                  maxWidth: `${colMaxWidthPx}px`,
                }}
                className="pointer-events-auto absolute -translate-y-1/2 flex flex-col leading-tight group"
              >
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleNodeLabelClick(node)}
                    className={`inline-flex items-center gap-0.5 text-left text-[11px] font-medium text-slate-800 truncate ${
                      isClickableLabel ? 'cursor-pointer hover:text-teal-800' : 'cursor-default'
                    }`}
                    title={node.name}
                  >
                    {node.canUnfold &&
                      (node.isExpanded ? (
                        <ChevronDown className="w-3 h-3 shrink-0 text-teal-700" />
                      ) : (
                        <ChevronRight className="w-3 h-3 shrink-0 text-slate-400 group-hover:text-teal-700" />
                      ))}
                    <span className="truncate">{node.name}</span>
                  </button>

                  {canAddInside && onInspectItem && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (node.nodeKind === 'pot' && node.potRef) {
                          onInspectItem('pot', node.potRef.pot.id);
                        } else if (node.nodeKind === 'obligation' && node.obRef) {
                          onInspectItem('obligation', node.obRef.id);
                        } else if (node.nodeKind === 'expense' && node.expRef) {
                          onInspectItem('expense', node.expRef.id);
                        }
                      }}
                      title={t.editBtn}
                      className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border border-slate-300/80 bg-white/90 text-slate-500 opacity-75 group-hover:opacity-100 hover:bg-slate-900 hover:text-white hover:border-slate-900 transition"
                    >
                      <Pencil className="w-2.5 h-2.5" />
                    </button>
                  )}

                  {canAddInside && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        triggerQuickAddForNode(node);
                      }}
                      title={node.nodeKind === 'pot' ? t.qaTooltipPot : t.qaTooltipPromote}
                      className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border transition ${
                        node.nodeKind === 'pot'
                          ? 'border-teal-600/40 bg-white/90 text-teal-700 hover:bg-teal-700 hover:text-white hover:border-teal-700'
                          : 'border-slate-300/80 bg-white/85 text-slate-500 opacity-75 group-hover:opacity-100 hover:bg-teal-700 hover:text-white hover:border-teal-700'
                      }`}
                    >
                      <Plus className="w-2.5 h-2.5 stroke-[2.5]" />
                    </button>
                  )}
                </div>

                <span className="text-[10px] font-mono-num text-slate-500 truncate pl-0.5">{valueText}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/**
 * 2. Multi-Period Historical Income vs. Spend & Cumulative Savings Trajectory Chart
 * Supports 1M (6M context), 3M, 6M, 12M, 5Y (20 quarters), and 10Y (10 years).
 */
export const HorizonHistoryChart: React.FC<{
  summary: HorizonSummary;
  currency: CurrencyCode;
  privacyMode: boolean;
  t: TranslationDict;
}> = ({ summary, currency, privacyMode, t }) => {
  const buckets = summary.buckets || [];
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  if (!buckets.length) return null;

  const width = 820;
  const height = 215;
  const padL = 24;
  const padR = 24;
  const padTop = 24;
  const padBot = 30;
  const plotW = width - padL - padR;
  const plotH = height - padTop - padBot;

  const maxBar = Math.max(1, ...buckets.flatMap((b) => [b.incomeMinor, b.spendMinor]));
  const cumVals = buckets.map((b) => b.cumulativeSavedMinor);
  const minCum = Math.min(0, ...cumVals);
  const maxCum = Math.max(maxBar, ...cumVals);
  const cumSpan = Math.max(1, maxCum - minCum);

  const slotW = plotW / Math.max(1, buckets.length);
  const barW = Math.min(18, Math.max(4, Math.floor(slotW * 0.34)));

  const toCumY = (val: number) => padTop + plotH - ((val - minCum) / cumSpan) * plotH;
  const cumPoints = buckets
    .map((b, idx) => {
      const cx = padL + idx * slotW + slotW / 2;
      const cy = toCumY(b.cumulativeSavedMinor);
      return `${cx.toFixed(1)},${cy.toFixed(1)}`;
    })
    .join(' ');

  const inspected = buckets[activeIdx != null && buckets[activeIdx] ? activeIdx : buckets.length - 1];

  return (
    <div className="space-y-3">
      {/* Period Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono-num">
        <div className="p-2.5 rounded-md bg-emerald-50/60 border border-emerald-200/70">
          <div className="text-[10px] uppercase text-emerald-800">{t.horizonEarnedLabel}</div>
          <div className="text-sm font-semibold text-emerald-900 mt-0.5">
            {formatDisplayValue(summary.totalIncomeMinor, { currency, privacyMode, compact: true })}
          </div>
          {!privacyMode && (
            <div className="text-[10px] text-emerald-700/80">
              {t.horizonAvgMoLabel}:{' '}
              {formatDisplayValue(summary.avgMonthlyIncomeMinor, { currency, privacyMode, compact: true })}
            </div>
          )}
        </div>
        <div className="p-2.5 rounded-md bg-slate-50 border border-slate-200">
          <div className="text-[10px] uppercase text-slate-500">{t.horizonSpentLabel}</div>
          <div className="text-sm font-semibold text-slate-900 mt-0.5">
            {formatDisplayValue(summary.totalSpendMinor, {
              currency,
              privacyMode,
              referenceTotalMinor: summary.totalIncomeMinor,
              compact: true,
            })}
          </div>
          {!privacyMode && (
            <div className="text-[10px] text-slate-500">
              {t.horizonAvgMoLabel}:{' '}
              {formatDisplayValue(summary.avgMonthlySpendMinor, { currency, privacyMode, compact: true })}
            </div>
          )}
        </div>
        <div className="p-2.5 rounded-md bg-teal-50/60 border border-teal-200/70">
          <div className="text-[10px] uppercase text-teal-800">{t.horizonSavedLabel}</div>
          <div className="text-sm font-semibold text-teal-900 mt-0.5">
            {formatDisplayValue(summary.totalSavedMinor, {
              currency,
              privacyMode,
              referenceTotalMinor: summary.totalIncomeMinor,
              compact: true,
            })}
          </div>
          <div className="text-[10px] text-teal-700">
            {summary.savingsRatePct}% {t.kpiSavingsRate.toLowerCase()}
          </div>
        </div>
        <div className="p-2.5 rounded-md bg-[#FAF9F6] border border-slate-200">
          <div className="text-[10px] uppercase text-slate-500">{inspected.subLabel}</div>
          <div className="text-xs font-semibold text-slate-900 mt-0.5">
            +{formatDisplayValue(inspected.savedMinor, { currency, privacyMode, compact: true })} ({inspected.savingsRatePct}%)
          </div>
          <div className="text-[10px] text-teal-800">
            {t.horizonCumSavedLabel}:{' '}
            {formatDisplayValue(inspected.cumulativeSavedMinor, { currency, privacyMode, compact: true })}
          </div>
        </div>
      </div>

      {/* SVG Grouped Bar + Cumulative Trajectory Chart */}
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none">
        <line
          x1={padL}
          x2={width - padR}
          y1={padTop + plotH}
          y2={padTop + plotH}
          stroke="#CBD5E1"
          strokeWidth={1}
        />

        {buckets.map((b, idx) => {
          const cx = padL + idx * slotW + slotW / 2;
          const incH = Math.max(3, (b.incomeMinor / maxBar) * (plotH - 12));
          const spdH = Math.max(3, (b.spendMinor / maxBar) * (plotH - 12));
          const baseY = padTop + plotH;
          const isHovered = (activeIdx ?? buckets.length - 1) === idx;
          const showLabel = buckets.length <= 12 || idx % 2 === 0 || idx === buckets.length - 1;

          return (
            <g
              key={b.key}
              className="cursor-pointer"
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => setActiveIdx(idx)}
            >
              <rect
                x={cx - slotW / 2 + 1}
                y={padTop}
                width={Math.max(4, slotW - 2)}
                height={plotH}
                fill={isHovered ? '#0F766E' : 'transparent'}
                fillOpacity={isHovered ? 0.06 : 0}
                rx={3}
              />
              {/* Income Bar */}
              <rect
                x={cx - barW - 1}
                y={baseY - incH}
                width={barW}
                height={incH}
                rx={2}
                fill="#0D9488"
                fillOpacity={isHovered ? 0.55 : 0.35}
              />
              {/* Spend Bar */}
              <rect
                x={cx + 1}
                y={baseY - spdH}
                width={barW}
                height={spdH}
                rx={2}
                fill="#334155"
                fillOpacity={isHovered ? 0.95 : 0.78}
              />
              {showLabel && (
                <text
                  x={cx}
                  y={height - 8}
                  textAnchor="middle"
                  className={`text-[10px] font-mono-num ${
                    isHovered ? 'fill-teal-800 font-semibold' : 'fill-slate-500'
                  }`}
                >
                  {b.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Cumulative Net Savings Trajectory Line */}
        {buckets.length > 1 && (
          <polyline
            fill="none"
            stroke="#0F766E"
            strokeWidth={2.2}
            strokeDasharray="4 2"
            points={cumPoints}
          />
        )}
        {buckets.map((b, idx) => {
          const cx = padL + idx * slotW + slotW / 2;
          const cy = toCumY(b.cumulativeSavedMinor);
          const isHovered = (activeIdx ?? buckets.length - 1) === idx;
          return (
            <circle
              key={`pt-${b.key}`}
              cx={cx}
              cy={cy}
              r={isHovered ? 4.2 : 2.8}
              fill="#0F766E"
              stroke="#FFFFFF"
              strokeWidth={1.5}
              className="cursor-pointer"
              onMouseEnter={() => setActiveIdx(idx)}
            />
          );
        })}
      </svg>
    </div>
  );
};

export const SixMonthTrendChart: React.FC<{
  data: Array<{ yearMonth: string; incomeMinor: number; spendMinor: number }>;
  currency: CurrencyCode;
  privacyMode: boolean;
}> = ({ data, currency, privacyMode }) => {
  const maxVal = Math.max(1, ...data.flatMap((d) => [d.incomeMinor, d.spendMinor]));
  return (
    <div className="grid grid-cols-6 gap-3 items-end h-44 pt-4">
      {data.map((d) => {
        const incH = Math.max(4, Math.round((d.incomeMinor / maxVal) * 115));
        const spdH = Math.max(4, Math.round((d.spendMinor / maxVal) * 115));
        const spendPct = d.incomeMinor > 0 ? Math.round((d.spendMinor / d.incomeMinor) * 100) : 0;
        return (
          <div key={d.yearMonth} className="flex flex-col items-center gap-1.5">
            <div className="text-[10px] font-mono-num text-slate-500">
              {privacyMode
                ? `${spendPct}%`
                : formatDisplayValue(d.spendMinor, { currency, privacyMode: false, compact: true })}
            </div>
            <div className="w-full flex items-end justify-center gap-1.5 h-[118px] border-b border-slate-200 pb-1">
              <div
                title="Income"
                style={{ height: `${incH}px` }}
                className="w-3 rounded-t bg-teal-700/35 transition-all"
              />
              <div
                title="Spend & Preserved"
                style={{ height: `${spdH}px` }}
                className="w-3 rounded-t bg-slate-700/80 transition-all"
              />
            </div>
            <div className="text-[10px] font-mono-num text-slate-500">{d.yearMonth.slice(5)}</div>
          </div>
        );
      })}
    </div>
  );
};

/**
 * 3. Account Sufficiency Daily Runway Curve (Timeline Tab)
 * Plots ALL logged expenses, completed checklist items (with timestamps), scheduled bills, and salary arrivals.
 */
export const DailyRunwayChart: React.FC<{
  curve: DailyCurvePoint[];
  currency: CurrencyCode;
  privacyMode: boolean;
  t: TranslationDict;
  onSelectDay?: (day: number) => void;
}> = ({ curve, currency, privacyMode, t, onSelectDay }) => {
  const [activeDay, setActiveDay] = useState<number | null>(null);
  if (!curve.length) return null;
  const width = 760;
  const height = 168;
  const padX = 28;
  const padY = 22;

  const vals = curve.map((c) => c.balanceMinor);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(100, ...vals);
  const span = Math.max(1, maxV - minV);

  const toX = (idx: number) => padX + (idx / Math.max(1, curve.length - 1)) * (width - padX * 2);
  const toY = (v: number) => height - padY - ((v - minV) / span) * (height - padY * 2);
  const zeroY = toY(0);

  const linePoints = curve.map((pt, i) => `${toX(i).toFixed(1)},${toY(pt.balanceMinor).toFixed(1)}`).join(' ');
  const areaPoints = `${toX(0).toFixed(1)},${zeroY.toFixed(1)} ${linePoints} ${toX(curve.length - 1).toFixed(1)},${zeroY.toFixed(1)}`;
  const startRef = Math.max(1, Math.abs(curve[0]?.balanceMinor || maxV));

  const firstDateStr = curve[0]?.date || '';
  const lastDateStr = curve[curve.length - 1]?.date || '';
  const isMultiPeriod =
    curve.length > 1 && firstDateStr.slice(0, 7) !== lastDateStr.slice(0, 7);

  const inspectedPoint =
    curve.find((pt) => pt.day === activeDay) ||
    curve.filter((pt) => (pt.events?.length || 0) > 0).slice(-1)[0] ||
    null;

  return (
    <div className="space-y-2">
      {/* Event Marker Legend */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono-num text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-rose-600 inline-block" />
          {t.timelineLegendExpense}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 inline-block" />
          {t.timelineLegendPaidBill}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full border-2 border-amber-500 bg-white inline-block" />
          {t.timelineLegendUnpaid}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-teal-700 inline-block" />
          {t.timelineLegendIncome}
        </span>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none">
        <line
          x1={padX}
          x2={width - padX}
          y1={zeroY}
          y2={zeroY}
          stroke="#EF4444"
          strokeDasharray="4 4"
          strokeOpacity={0.45}
        />
        <polygon points={areaPoints} fill="#0F766E" fillOpacity={0.1} />
        <polyline fill="none" stroke="#0F766E" strokeWidth={2} points={linePoints} />

        {curve.map((pt, idx) => {
          const evs = pt.events ?? [];
          if (!evs.length && !pt.label) return null;
          const cx = toX(idx);
          const cy = toY(pt.balanceMinor);
          const hasExpense = evs.some((e) => e.kind === 'expense');
          const hasPaid = evs.some((e) => e.kind === 'paid_bill' || e.kind === 'sinking_set_aside');
          const hasIncome = evs.some((e) => e.kind === 'income');
          const hasUnpaid = evs.some((e) => e.kind === 'unpaid_bill');

          let fill = '#0F766E';
          let stroke = '#FFFFFF';
          if (hasExpense) {
            fill = '#E11D48';
          } else if (hasPaid) {
            fill = '#059669';
          } else if (hasIncome) {
            fill = '#0F766E';
          } else if (hasUnpaid) {
            fill = '#FFFFFF';
            stroke = '#D97706';
          }

          const isSelected = inspectedPoint?.day === pt.day;

          return (
            <g
              key={pt.day}
              className="cursor-pointer"
              onMouseEnter={() => setActiveDay(pt.day)}
              onClick={() => {
                setActiveDay(pt.day);
                onSelectDay?.(pt.day);
              }}
            >
              <line
                x1={cx}
                x2={cx}
                y1={cy}
                y2={height - padY}
                stroke={hasExpense ? '#E11D48' : hasPaid ? '#059669' : '#94A3B8'}
                strokeDasharray="2 2"
                strokeOpacity={isSelected ? 0.65 : 0.25}
              />
              <circle
                cx={cx}
                cy={cy}
                r={isSelected ? 5.5 : 4.2}
                fill={fill}
                stroke={stroke}
                strokeWidth={2}
              />
              {evs.length > 1 && (
                <circle
                  cx={cx + 4}
                  cy={cy - 4}
                  r={2.5}
                  fill={hasPaid && hasExpense ? '#059669' : '#334155'}
                />
              )}
              {(!isMultiPeriod || pt.label) && (
                <text
                  x={cx}
                  y={height - 5}
                  textAnchor="middle"
                  className="fill-slate-400 text-[9px] font-mono-num"
                >
                  {isMultiPeriod ? pt.label : `${pt.day}.`}
                </text>
              )}
            </g>
          );
        })}

        <text x={padX} y={13} className="fill-slate-500 text-[10px] font-mono-num">
          {isMultiPeriod ? firstDateStr.split(' ')[0] : t.day1}:{' '}
          {privacyMode
            ? '100%'
            : formatDisplayValue(curve[0].balanceMinor, { currency, privacyMode: false, compact: true })}
        </text>
        <text x={width - padX} y={13} textAnchor="end" className="fill-slate-600 text-[10px] font-mono-num">
          {isMultiPeriod ? lastDateStr.split(' ').slice(-1)[0] : t.endOfMonth}:{' '}
          {formatDisplayValue(curve[curve.length - 1].balanceMinor, {
            currency,
            privacyMode,
            referenceTotalMinor: startRef,
            compact: true,
          })}
        </text>
      </svg>

      {/* Interactive Day Callout Pill showing plotted Expenses & Completed Checklist Items on hovered/selected day */}
      {inspectedPoint && (inspectedPoint.events?.length || 0) > 0 && (
        <div className="px-3 py-2 rounded-md bg-[#FAF9F6] border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs font-mono-num">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-800">
              {inspectedPoint.date || `Day ${inspectedPoint.day}`}:
            </span>
            {inspectedPoint.events!.map((ev) => {
              const badgeCls =
                ev.kind === 'expense'
                  ? 'bg-rose-50 text-rose-800 border-rose-200'
                  : ev.kind === 'paid_bill' || ev.kind === 'sinking_set_aside'
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : ev.kind === 'income'
                  ? 'bg-teal-50 text-teal-800 border-teal-200'
                  : 'bg-amber-50 text-amber-800 border-amber-200';
              const timeStr =
                ev.timestamp && ev.timestamp.length >= 16 && ev.timestamp.includes('T')
                  ? ` ${ev.timestamp.slice(11, 16)}`
                  : '';
              return (
                <span
                  key={ev.id}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] ${badgeCls}`}
                >
                  <span>
                    {ev.title}
                    {timeStr}
                  </span>
                  <span className="font-semibold">
                    {ev.kind === 'income' ? '+' : '-'}
                    {formatDisplayValue(ev.displayMinor, {
                      currency,
                      privacyMode,
                      referenceTotalMinor: startRef,
                      compact: true,
                    })}
                  </span>
                </span>
              );
            })}
          </div>
          <span className="text-slate-500 text-[11px]">
            Bal:{' '}
            <strong className="text-slate-800">
              {formatDisplayValue(inspectedPoint.balanceMinor, {
                currency,
                privacyMode,
                referenceTotalMinor: startRef,
                compact: true,
              })}
            </strong>
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * 4. Proportional Nested Pot Strip & Infinite-Depth Breadcrumb Drilldown (Pots Tab)
 */
export const PotProportionStrip: React.FC<{
  nodes: PotRollupNode[];
  pots: PotRecord[];
  obligations: EnrichedObligation[];
  expenses: EnrichedExpense[];
  currency: CurrencyCode;
  privacyMode: boolean;
  selectedPotId: string | null;
  onSelectPot: (id: string | null) => void;
  t: TranslationDict;
}> = ({ nodes, pots, obligations, expenses, currency, privacyMode, selectedPotId, onSelectPot, t }) => {
  const crumbsMap = useMemo(() => buildPotBreadcrumbs(pots), [pots]);

  // Locate selected PotRollupNode at arbitrary depth
  const focusedNode = useMemo(() => {
    if (!selectedPotId) return null;
    const findRec = (list: PotRollupNode[]): PotRollupNode | null => {
      for (const n of list) {
        if (n.pot.id === selectedPotId) return n;
        const found = findRec(n.children);
        if (found) return found;
      }
      return null;
    };
    return findRec(nodes);
  }, [nodes, selectedPotId]);

  const segments = useMemo(() => {
    if (!focusedNode) {
      return nodes
        .filter((n) => n.effectiveTotalDisplayMinor > 0)
        .map((n) => ({
          id: n.pot.id,
          name: n.pot.name,
          color: n.pot.color || '#2E6F7E',
          valueMinor: n.effectiveTotalDisplayMinor,
          selectablePotId: n.pot.id as string | null,
        }));
    }

    const parts: Array<{
      id: string;
      name: string;
      color: string;
      valueMinor: number;
      selectablePotId: string | null;
    }> = [];

    for (const ch of focusedNode.children) {
      if (ch.effectiveTotalDisplayMinor > 0) {
        parts.push({
          id: ch.pot.id,
          name: ch.pot.name,
          color: ch.pot.color || focusedNode.pot.color || '#2E6F7E',
          valueMinor: ch.effectiveTotalDisplayMinor,
          selectablePotId: ch.pot.id,
        });
      }
    }

    for (const ob of obligations) {
      if (ob.isActive && ob.potId === focusedNode.pot.id && ob.effectiveDisplayMinor > 0) {
        parts.push({
          id: `ob-${ob.id}`,
          name: ob.name,
          color: '#475569',
          valueMinor: ob.effectiveDisplayMinor,
          selectablePotId: null,
        });
      }
    }

    for (const exp of expenses) {
      if (exp.potId === focusedNode.pot.id && exp.displayAmountMinor > 0) {
        parts.push({
          id: `exp-${exp.id}`,
          name: exp.merchant,
          color: '#0F766E',
          valueMinor: exp.displayAmountMinor,
          selectablePotId: null,
        });
      }
    }

    if (focusedNode.unallocatedEnvelopeDisplayMinor > 0) {
      parts.push({
        id: `env-${focusedNode.pot.id}`,
        name: t.sankeyRemainingEnv,
        color: '#94A3B8',
        valueMinor: focusedNode.unallocatedEnvelopeDisplayMinor,
        selectablePotId: null,
      });
    }

    return parts;
  }, [focusedNode, nodes, obligations, expenses, t]);

  const total = segments.reduce((s, seg) => s + seg.valueMinor, 0);
  const selectedCrumb = selectedPotId ? crumbsMap.get(selectedPotId) : null;

  return (
    <div className="space-y-3">
      {/* Infinite-Depth Breadcrumb Bar */}
      {selectedCrumb && (
        <div className="flex flex-wrap items-center gap-1 text-xs font-mono-num text-slate-500">
          <button
            type="button"
            onClick={() => onSelectPot(null)}
            className="text-teal-700 hover:underline font-medium"
          >
            {t.allPotsCrumb}
          </button>
          {selectedCrumb.ancestorIds.map((ancId, idx) => {
            const label = selectedCrumb.pathNames[idx];
            const isLast = idx === selectedCrumb.ancestorIds.length - 1;
            return (
              <React.Fragment key={ancId}>
                <span className="text-slate-300">/</span>
                <button
                  type="button"
                  onClick={() => onSelectPot(ancId)}
                  className={isLast ? 'font-semibold text-slate-900' : 'text-teal-700 hover:underline'}
                >
                  {label}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}

      {!segments.length || total <= 0 ? (
        <div className="text-xs text-slate-400 font-mono-num">{t.sankeyEmpty}</div>
      ) : (
        <>
          <div className="flex h-7 w-full overflow-hidden rounded-md border border-slate-200 bg-slate-100">
            {segments.map((seg) => {
              const pct = (seg.valueMinor / total) * 100;
              return (
                <button
                  key={seg.id}
                  type="button"
                  onClick={() => seg.selectablePotId && onSelectPot(seg.selectablePotId)}
                  style={{ width: `${Math.max(2, pct)}%`, backgroundColor: seg.color }}
                  className={`h-full transition-opacity hover:opacity-95 border-r border-white/40 ${
                    seg.selectablePotId ? 'cursor-pointer opacity-90' : 'cursor-default opacity-80'
                  }`}
                  title={`${seg.name}: ${pct.toFixed(1)}%`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            {segments.map((seg) => (
              <button
                key={seg.id}
                type="button"
                onClick={() => seg.selectablePotId && onSelectPot(seg.selectablePotId)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs transition ${
                  seg.selectablePotId
                    ? 'border-slate-200 bg-white text-slate-700 hover:border-teal-600 cursor-pointer'
                    : 'border-slate-100 bg-slate-50 text-slate-600 cursor-default'
                }`}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: seg.color }} />
                <span>{seg.name}</span>
                <span className="font-mono-num text-slate-500">
                  {formatDisplayValue(seg.valueMinor, {
                    currency,
                    privacyMode,
                    referenceTotalMinor: total,
                    compact: true,
                  })}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

/**
 * 5. Long-Horizon Wealth History & Belongings Forecast Chart (Wealth Tab)
 * Supports Past History (-10Y / -5Y / -3Y / -1Y) AND Future Forecast (+5Y / +10Y / +20Y),
 * interactive year inspection, and zero-overlap label geometry.
 */
export const WealthHorizonChart: React.FC<{
  history: Array<{ date: string; netWorthMinor: number; assetsMinor?: number; liabilitiesMinor?: number }>;
  projection: HorizonProjectionPoint[];
  currency: CurrencyCode;
  privacyMode: boolean;
  t: TranslationDict;
}> = ({ history, projection, currency, privacyMode, t }) => {
  const [hoveredYear, setHoveredYear] = useState<number | null>(null);
  if (!projection.length) return null;

  const width = 820;
  const height = 248;
  const padL = 44;
  const padR = 44;
  const padTop = 34;
  const padBot = 28;
  const plotH = height - padTop - padBot;

  const nowYear = projection[0]?.year ?? new Date().getFullYear();

  const histPoints = history
    .map((h) => ({
      year: Number(h.date.slice(0, 4)),
      netWorthMinor: h.netWorthMinor,
      totalAssetsMinor: h.assetsMinor ?? h.netWorthMinor,
      liabilitiesMinor: h.liabilitiesMinor ?? 0,
      isHistory: true,
    }))
    .filter((h) => h.year < nowYear);

  const projPoints = projection.map((p) => ({
    year: p.year,
    netWorthMinor: p.netWorthMinor,
    totalAssetsMinor: p.totalAssetsMinor,
    liabilitiesMinor: p.totalLiabilitiesMinor,
    isHistory: false,
  }));

  const combined = [...histPoints, ...projPoints];
  if (!combined.length) return null;

  const minYear = combined[0]?.year ?? nowYear;
  const maxYear = combined[combined.length - 1]?.year ?? nowYear;
  const yearSpan = Math.max(1, maxYear - minYear);

  const allVals = [
    0,
    ...combined.map((c) => c.netWorthMinor),
    ...combined.map((c) => c.totalAssetsMinor),
    ...combined.map((c) => c.liabilitiesMinor),
  ];
  const minV = Math.min(0, ...allVals);
  const maxV = Math.max(100, Math.round(Math.max(...allVals) * 1.12));
  const valSpan = Math.max(1, maxV - minV);

  const toX = (yr: number) =>
    yearSpan === 0 ? width / 2 : padL + ((yr - minYear) / yearSpan) * (width - padL - padR);
  const toY = (v: number) => padTop + plotH - ((v - minV) / valSpan) * plotH;
  const zeroY = toY(0);

  const nwLine = combined.map((c) => `${toX(c.year).toFixed(1)},${toY(c.netWorthMinor).toFixed(1)}`).join(' ');
  const nwArea = `${toX(minYear).toFixed(1)},${zeroY.toFixed(1)} ${nwLine} ${toX(maxYear).toFixed(1)},${zeroY.toFixed(1)}`;

  const assetsLine = combined
    .map((c) => `${toX(c.year).toFixed(1)},${toY(c.totalAssetsMinor).toFixed(1)}`)
    .join(' ');
  const debtLine = combined
    .map((c) => `${toX(c.year).toFixed(1)},${toY(c.liabilitiesMinor).toFixed(1)}`)
    .join(' ');

  const nowPt = projPoints[0] ?? combined[combined.length - 1]!;
  const startPt = combined[0]!;
  const endPt = combined[combined.length - 1]!;
  const baselineMinor = Math.max(1, Math.abs(nowPt.netWorthMinor || 1));
  const nowX = toX(nowPt.year);

  const activePt =
    combined.find((c) => c.year === hoveredYear) ||
    (endPt.year !== nowPt.year ? endPt : startPt) ||
    nowPt;

  const hasDebt = combined.some((c) => c.liabilitiesMinor > 0);

  // Pick non-overlapping X-axis year tick labels
  const xTickYears: number[] = [];
  let lastTickX = -999;
  for (const pt of combined) {
    const cx = toX(pt.year);
    const isMilestone = pt.year === minYear || pt.year === nowPt.year || pt.year === maxYear;
    if (isMilestone || cx - lastTickX >= 56) {
      if (xTickYears.length > 0 && cx - lastTickX < 36 && pt.year !== nowPt.year && pt.year !== maxYear) {
        continue;
      }
      if (xTickYears.length > 0 && cx - lastTickX < 36 && (pt.year === nowPt.year || pt.year === maxYear)) {
        xTickYears.pop();
      }
      xTickYears.push(pt.year);
      lastTickX = cx;
    }
  }

  return (
    <div className="space-y-3">
      {/* Legend & Milestone Summary Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-num text-slate-600">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5 font-semibold text-teal-900">
            <span className="w-3 h-1 rounded bg-[#1E5F74] inline-block" />
            Net Worth
          </span>
          <span className="inline-flex items-center gap-1.5 text-emerald-800">
            <span className="w-3 h-0.5 border-t-2 border-dashed border-emerald-600 inline-block" />
            {t.assetsShort}
          </span>
          {hasDebt && (
            <span className="inline-flex items-center gap-1.5 text-amber-800">
              <span className="w-3 h-0.5 border-t-2 border-dashed border-amber-600 inline-block" />
              {t.debtShort}
            </span>
          )}
        </div>

        {/* Non-overlapping Milestone Pills: History Start · Now · Forecast End */}
        <div className="flex flex-wrap items-center gap-2">
          {startPt.year < nowPt.year && (
            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
              {startPt.year}:{' '}
              <strong>{formatIndexedWealth(startPt.netWorthMinor, baselineMinor, currency, privacyMode)}</strong>
            </span>
          )}
          <span className="px-2 py-0.5 rounded bg-teal-50 text-teal-900 border border-teal-200">
            {t.nowLabel} ({nowPt.year}):{' '}
            <strong>{formatIndexedWealth(nowPt.netWorthMinor, baselineMinor, currency, privacyMode)}</strong>
          </span>
          {endPt.year > nowPt.year && (
            <span className="px-2 py-0.5 rounded bg-slate-900 text-white">
              {endPt.year}:{' '}
              <strong>{formatIndexedWealth(endPt.netWorthMinor, baselineMinor, currency, privacyMode)}</strong>
            </span>
          )}
        </div>
      </div>

      {/* SVG Trajectory Plot */}
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none">
        {/* Zero Baseline */}
        <line x1={padL} x2={width - padR} y1={zeroY} y2={zeroY} stroke="#CBD5E1" strokeWidth={1} />

        {/* Shaded Net Worth Area */}
        <polygon points={nwArea} fill="#1E5F74" fillOpacity={0.12} />

        {/* Total Assets Upper Dashed Curve */}
        <polyline
          fill="none"
          stroke="#059669"
          strokeWidth={1.6}
          strokeDasharray="4 3"
          strokeOpacity={0.65}
          points={assetsLine}
        />

        {/* Mortgage & Debt Lower Dashed Curve (Amortizing down toward 0) */}
        {hasDebt && (
          <polyline
            fill="none"
            stroke="#D97706"
            strokeWidth={1.6}
            strokeDasharray="4 3"
            strokeOpacity={0.75}
            points={debtLine}
          />
        )}

        {/* Primary Net Worth Curve */}
        <polyline fill="none" stroke="#1E5F74" strokeWidth={2.6} points={nwLine} />

        {/* Vertical 'Now' Divider Line + Top Header Label (Placed at y=16 above plot area so it NEVER overlaps curve labels) */}
        <line
          x1={nowX}
          x2={nowX}
          y1={20}
          y2={height - padBot}
          stroke="#0F766E"
          strokeDasharray="3 3"
          strokeOpacity={0.65}
        />
        <text
          x={Math.min(width - padR - 4, Math.max(padL + 4, nowX))}
          y={14}
          textAnchor={
            nowX < padL + 70 ? 'start' : nowX > width - padR - 70 ? 'end' : 'middle'
          }
          className="fill-teal-800 text-[10px] font-mono-num font-semibold"
        >
          {t.nowLabel} ({nowPt.year}): {formatIndexedWealth(nowPt.netWorthMinor, baselineMinor, currency, privacyMode)}
        </text>

        {/* Leftmost & Rightmost Curve Endpoint Callouts (Only rendered if >= 95px away from each other) */}
        {startPt.year < nowPt.year && nowX - toX(startPt.year) >= 95 && (
          <text
            x={toX(startPt.year) + 4}
            y={Math.max(28, toY(startPt.netWorthMinor) - 9)}
            textAnchor="start"
            className="fill-slate-600 text-[10px] font-mono-num font-medium"
          >
            {startPt.year}: {formatIndexedWealth(startPt.netWorthMinor, baselineMinor, currency, privacyMode)}
          </text>
        )}
        {endPt.year > nowPt.year && toX(endPt.year) - nowX >= 95 && (
          <text
            x={toX(endPt.year) - 4}
            y={Math.max(28, toY(endPt.netWorthMinor) - 9)}
            textAnchor="end"
            className="fill-slate-800 text-[10px] font-mono-num font-semibold"
          >
            {endPt.year}: {formatIndexedWealth(endPt.netWorthMinor, baselineMinor, currency, privacyMode)}
          </text>
        )}

        {/* Interactive Year Dots */}
        {combined.map((pt) => {
          const cx = toX(pt.year);
          const cy = toY(pt.netWorthMinor);
          const isHovered = activePt.year === pt.year;
          const isNow = pt.year === nowPt.year;
          return (
            <g
              key={pt.year}
              className="cursor-pointer"
              onMouseEnter={() => setHoveredYear(pt.year)}
              onClick={() => setHoveredYear(pt.year)}
            >
              {isHovered && (
                <line
                  x1={cx}
                  x2={cx}
                  y1={padTop}
                  y2={height - padBot}
                  stroke="#0F766E"
                  strokeOpacity={0.25}
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={isHovered ? 5 : isNow ? 4.2 : 3}
                fill={isNow ? '#0F766E' : pt.isHistory ? '#475569' : '#1E5F74'}
                stroke="#FFFFFF"
                strokeWidth={1.6}
              />
            </g>
          );
        })}

        {/* Bottom X-Axis Year Tick Labels */}
        {xTickYears.map((yr) => (
          <text
            key={`tick-${yr}`}
            x={toX(yr)}
            y={height - 8}
            textAnchor="middle"
            className={`text-[10px] font-mono-num ${
              yr === nowPt.year
                ? 'fill-teal-800 font-semibold'
                : activePt.year === yr
                ? 'fill-slate-900 font-semibold'
                : 'fill-slate-400'
            }`}
          >
            {yr}
          </text>
        ))}
      </svg>

      {/* Interactive Hovered/Selected Year Breakdown Bar */}
      <div className="px-3 py-2 rounded-md bg-[#FAF9F6] border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs font-mono-num">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-900">{activePt.year}</span>
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] ${
              activePt.year < nowPt.year
                ? 'bg-slate-200/80 text-slate-700'
                : activePt.year === nowPt.year
                ? 'bg-teal-100 text-teal-900 font-semibold'
                : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
            }`}
          >
            {activePt.year < nowPt.year
              ? `${activePt.year - nowPt.year}Y History`
              : activePt.year === nowPt.year
              ? t.nowLabel
              : `+${activePt.year - nowPt.year}Y Forecast`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <span>
            Net Worth:{' '}
            <strong className="text-teal-900">
              {formatIndexedWealth(activePt.netWorthMinor, baselineMinor, currency, privacyMode)}
            </strong>
          </span>
          <span className="text-emerald-800">
            {t.assetsShort}:{' '}
            <strong>{formatIndexedWealth(activePt.totalAssetsMinor, baselineMinor, currency, privacyMode)}</strong>
          </span>
          <span className="text-amber-800">
            {t.debtShort}:{' '}
            <strong>{formatIndexedWealth(activePt.liabilitiesMinor, baselineMinor, currency, privacyMode)}</strong>
          </span>
        </div>
      </div>
    </div>
  );
};
