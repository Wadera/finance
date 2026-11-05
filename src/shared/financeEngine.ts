import { convertMinor } from './currency.js';
import type {
  AssetBelongingRecord,
  CadenceKind,
  CurrencyCode,
  ExpenseEntryRecord,
  IncomeStreamRecord,
  LiabilityRecord,
  ObligationRecord,
  PotRecord,
  SplitMode,
} from './types.js';

/** Difference in whole calendar months: (dueYear - curYear)*12 + (dueMonth - curMonth) */
export function diffYearMonths(fromYearMonth: string, toYearMonth: string): number {
  const [fy, fm] = fromYearMonth.split('-').map(Number);
  const [ty, tm] = toYearMonth.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export function addMonthsToDate(isoDate: string, monthsToAdd: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const totalMonths = y * 12 + (m - 1) + monthsToAdd;
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1;
  const maxDay = new Date(ny, nm, 0).getDate();
  const nd = Math.min(d, maxDay);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

export function cadenceIntervalMonths(cadence: CadenceKind, customInterval: number): number {
  switch (cadence) {
    case 'once':
      return 0;
    case 'weekly':
      return 1;
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'biannual':
      return 6;
    case 'annual':
      return 12;
    case 'custom_months':
      return Math.max(1, customInterval || 1);
  }
}

export interface ObligationMonthMetrics {
  obligationId: string;
  isDueThisMonth: boolean;
  monthsUntilDue: number;
  /** Native-currency amount due directly in `yearMonth` */
  dueThisMonthNativeMinor: number;
  /**
   * Native-currency 'Preserve' sinking-fund amount to put aside in `yearMonth`
   * for upcoming future due dates (e.g. £150 in 3m -> £50/mo; after reset for 12m -> £12.50/mo).
   */
  monthlyPreserveNativeMinor: number;
  /** Effective monthly budget burden in native currency (either direct monthly bill or sinking preserve slice) */
  effectiveMonthlyBurdenNativeMinor: number;
}

/**
 * Pure Sinking-Fund ("Preserve") Calculation Engine:
 * - Example 1: £150 scheduled 3 months from now (Nov -> Feb), preserved = £0:
 *   monthsUntilDue = 3 -> monthlyPreserve = £150 / 3 = £50.00/mo.
 * - Example 2: Once paid in Feb, if annual (12m), nextDueDate advances to next Feb (+12m) and preserved resets to £0:
 *   monthsUntilDue = 12 -> monthlyPreserve = £150 / 12 = £12.50/mo.
 * - Regular monthly bills due this month have monthlyPreserve = 0 and dueThisMonth = amountMinor.
 */
export function computeObligationMonthMetrics(
  ob: ObligationRecord,
  yearMonth: string
): ObligationMonthMetrics {
  if (!ob.isActive) {
    return {
      obligationId: ob.id,
      isDueThisMonth: false,
      monthsUntilDue: 0,
      dueThisMonthNativeMinor: 0,
      monthlyPreserveNativeMinor: 0,
      effectiveMonthlyBurdenNativeMinor: 0,
    };
  }

  const dueYm = ob.nextDueDate.slice(0, 7);
  const monthsDiff = diffYearMonths(yearMonth, dueYm);

  // Weekly cadence normalized to monthly (52 / 12 = 4.3333 weeks/month)
  if (ob.cadence === 'weekly') {
    const monthlyEquiv = Math.round((ob.amountMinor * 52) / 12);
    return {
      obligationId: ob.id,
      isDueThisMonth: monthsDiff <= 0,
      monthsUntilDue: Math.max(0, monthsDiff),
      dueThisMonthNativeMinor: monthsDiff <= 0 ? monthlyEquiv : 0,
      monthlyPreserveNativeMinor: monthsDiff > 0 && ob.autoPreserve ? Math.round(monthlyEquiv / monthsDiff) : 0,
      effectiveMonthlyBurdenNativeMinor: monthlyEquiv,
    };
  }

  // Standard monthly cadence
  if (ob.cadence === 'monthly') {
    return {
      obligationId: ob.id,
      isDueThisMonth: true,
      monthsUntilDue: 0,
      dueThisMonthNativeMinor: ob.amountMinor,
      monthlyPreserveNativeMinor: 0,
      effectiveMonthlyBurdenNativeMinor: ob.amountMinor,
    };
  }

  // Past or current due month for one-time or multi-month recurring obligations
  if (monthsDiff <= 0) {
    if (ob.cadence === 'once' && monthsDiff < 0) {
      // Past one-time obligation before selected month
      return {
        obligationId: ob.id,
        isDueThisMonth: false,
        monthsUntilDue: 0,
        dueThisMonthNativeMinor: 0,
        monthlyPreserveNativeMinor: 0,
        effectiveMonthlyBurdenNativeMinor: 0,
      };
    }
    // Due right now in `yearMonth`: remaining unfunded gap is what hits this month's budget
    const remainingGap = Math.max(0, ob.amountMinor - ob.preservedMinor);
    return {
      obligationId: ob.id,
      isDueThisMonth: monthsDiff === 0,
      monthsUntilDue: 0,
      dueThisMonthNativeMinor: monthsDiff === 0 ? ob.amountMinor : 0,
      monthlyPreserveNativeMinor: monthsDiff === 0 ? remainingGap : 0,
      effectiveMonthlyBurdenNativeMinor: monthsDiff === 0 ? remainingGap : 0,
    };
  }

  // Future due month (monthsDiff >= 1): Sinking-Fund 'Preserve' slice!
  const remainingTarget = Math.max(0, ob.amountMinor - ob.preservedMinor);
  const preserveSlice = ob.autoPreserve ? Math.round(remainingTarget / monthsDiff) : 0;

  return {
    obligationId: ob.id,
    isDueThisMonth: false,
    monthsUntilDue: monthsDiff,
    dueThisMonthNativeMinor: 0,
    monthlyPreserveNativeMinor: preserveSlice,
    effectiveMonthlyBurdenNativeMinor: preserveSlice,
  };
}

/**
 * Advances an obligation when the user ticks "[✓] Mark as Paid".
 * Resets `preservedMinor` to 0 and advances `nextDueDate` by the recurrence interval
 * (or marks `isActive = false` if `cadence === 'once'`).
 */
export function applyObligationPaymentReset(ob: ObligationRecord): {
  nextDueDate: string;
  preservedMinor: number;
  isActive: boolean;
} {
  if (ob.cadence === 'once') {
    return {
      nextDueDate: ob.nextDueDate,
      preservedMinor: 0,
      isActive: false,
    };
  }
  const interval = cadenceIntervalMonths(ob.cadence, ob.intervalMonths);
  return {
    nextDueDate: addMonthsToDate(ob.nextDueDate, interval),
    preservedMinor: 0,
    isActive: true,
  };
}

/** Calculates Wadera's share in basis points (0..10000) for a shared obligation/expense */
export function resolveWaderaShareBp(
  splitMode: SplitMode,
  customBp: number,
  waderaMonthlyIncomeGbpMinor: number,
  walterMonthlyIncomeGbpMinor: number
): number {
  switch (splitMode) {
    case 'equal_50_50':
      return 5000;
    case 'custom_bp':
      return Math.min(10000, Math.max(0, customBp));
    case 'owner_only':
      return 10000;
    case 'income_proportional': {
      const total = waderaMonthlyIncomeGbpMinor + walterMonthlyIncomeGbpMinor;
      if (total <= 0) return 5000;
      return Math.round((waderaMonthlyIncomeGbpMinor / total) * 10000);
    }
  }
}

export function computeMonthlyIncomeMinor(
  inc: IncomeStreamRecord,
  yearMonth: string,
  targetCurrency: CurrencyCode,
  rateMap: Record<CurrencyCode, number>
): number {
  if (!inc.isActive) return 0;
  const startYm = inc.effectiveFrom.slice(0, 7);
  const endYm = inc.effectiveTo ? inc.effectiveTo.slice(0, 7) : null;
  if (yearMonth < startYm) return 0;
  if (endYm && yearMonth > endYm) return 0;

  let monthlyNative = inc.amountMinor;
  if (inc.cadence === 'annual') {
    monthlyNative = Math.round(inc.amountMinor / 12);
  } else if (inc.cadence === 'once') {
    if (startYm !== yearMonth) return 0;
  }
  return convertMinor(monthlyNative, inc.currency, targetCurrency, rateMap);
}

export interface PotBreadcrumbInfo {
  potId: string;
  ancestorIds: string[];
  pathNames: string[];
  pathString: string;
  depth: number;
}

/**
 * Builds cycle-safe unlimited-depth breadcrumb metadata for every pot.
 */
export function buildPotBreadcrumbs(pots: PotRecord[]): Map<string, PotBreadcrumbInfo> {
  const byId = new Map(pots.map((p) => [p.id, p]));
  const out = new Map<string, PotBreadcrumbInfo>();

  for (const pot of pots) {
    const names: string[] = [pot.name];
    const ids: string[] = [pot.id];
    const seen = new Set<string>([pot.id]);
    let curParentId = pot.parentId;

    while (curParentId && byId.has(curParentId) && !seen.has(curParentId)) {
      seen.add(curParentId);
      const parent = byId.get(curParentId)!;
      names.unshift(parent.name);
      ids.unshift(parent.id);
      curParentId = parent.parentId;
    }

    out.set(pot.id, {
      potId: pot.id,
      ancestorIds: ids,
      pathNames: names,
      pathString: names.join(' › '),
      depth: names.length - 1,
    });
  }

  return out;
}

/**
 * Collects `rootPotId` plus all recursive descendant pot IDs at unlimited depth (cycle-safe).
 */
export function collectSubtreePotIds(rootPotId: string, pots: PotRecord[]): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const p of pots) {
    if (p.parentId && p.parentId !== p.id) {
      const list = byParent.get(p.parentId) ?? [];
      list.push(p.id);
      byParent.set(p.parentId, list);
    }
  }

  const visited = new Set<string>();
  const stack = [rootPotId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const kids = byParent.get(id);
    if (kids) {
      for (const k of kids) {
        if (!visited.has(k)) stack.push(k);
      }
    }
  }
  return visited;
}

export interface PotRollupNode {
  pot: PotRecord;
  estimateDisplayMinor: number;
  itemizedSpendDisplayMinor: number;
  scheduledDueDisplayMinor: number;
  preserveSliceDisplayMinor: number;
  /** Direct + children combined projected monthly budget impact (respecting envelopeMode without double counting) */
  effectiveTotalDisplayMinor: number;
  unallocatedEnvelopeDisplayMinor: number;
  children: PotRollupNode[];
}

/**
 * Hierarchical Pot Roll-Up Engine (Unlimited Nesting Depth, Cycle-Safe):
 * - Supports arbitrarily deep nested pots (Level 0 -> Level 1 -> ... -> Level N).
 * - If a pot has `envelopeMode = true` with £600 estimate and £85 itemized groceries,
 *   effectiveTotal = £600 (£85 itemized + £515 unallocated envelope) — NO double counting!
 *   If itemized + scheduled exceeds £600 (say £640), effectiveTotal = £640.
 */
export function buildPotRollupTree(
  pots: PotRecord[],
  obligations: ObligationRecord[],
  expenses: ExpenseEntryRecord[],
  yearMonth: string,
  displayCurrency: CurrencyCode,
  rateMap: Record<CurrencyCode, number>
): PotRollupNode[] {
  const potIds = new Set(pots.map((p) => p.id));
  const byId = new Map(pots.map((p) => [p.id, p]));

  // Detect any cyclic parent_id chains so cyclic nodes fall back cleanly without infinite recursion
  const hasCycleFrom = (startId: string): boolean => {
    const seen = new Set<string>([startId]);
    let cur = byId.get(startId)?.parentId ?? null;
    while (cur && potIds.has(cur)) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    return false;
  };

  const byParent = new Map<string | null, PotRecord[]>();
  for (const p of pots) {
    const validParent =
      p.parentId && p.parentId !== p.id && potIds.has(p.parentId) && !hasCycleFrom(p.id)
        ? p.parentId
        : null;
    const arr = byParent.get(validParent) ?? [];
    arr.push(p);
    byParent.set(validParent, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  const monthExpenses = expenses.filter((e) => e.spentDate.slice(0, 7) === yearMonth);
  const visited = new Set<string>();

  const buildNode = (pot: PotRecord): PotRollupNode => {
    visited.add(pot.id);
    const childPots = (byParent.get(pot.id) ?? []).filter((c) => !visited.has(c.id));
    const children = childPots.map(buildNode);

    const directExpensesMinor = monthExpenses
      .filter((e) => e.potId === pot.id)
      .reduce((sum, e) => sum + convertMinor(e.amountMinor, e.currency, displayCurrency, rateMap), 0);

    let directScheduledMinor = 0;
    let directPreserveMinor = 0;
    for (const ob of obligations.filter((o) => o.potId === pot.id)) {
      const m = computeObligationMonthMetrics(ob, yearMonth);
      if (m.isDueThisMonth && ob.cadence === 'monthly') {
        directScheduledMinor += convertMinor(m.dueThisMonthNativeMinor, ob.currency, displayCurrency, rateMap);
      } else if (m.isDueThisMonth) {
        directScheduledMinor += convertMinor(m.effectiveMonthlyBurdenNativeMinor, ob.currency, displayCurrency, rateMap);
      } else {
        directPreserveMinor += convertMinor(m.monthlyPreserveNativeMinor, ob.currency, displayCurrency, rateMap);
      }
    }

    const childItemized = children.reduce((s, c) => s + c.itemizedSpendDisplayMinor, 0);
    const childScheduled = children.reduce((s, c) => s + c.scheduledDueDisplayMinor, 0);
    const childPreserve = children.reduce((s, c) => s + c.preserveSliceDisplayMinor, 0);
    const childEffectiveSum = children.reduce((s, c) => s + c.effectiveTotalDisplayMinor, 0);

    const totalItemized = directExpensesMinor + childItemized;
    const totalScheduled = directScheduledMinor + childScheduled;
    const totalPreserve = directPreserveMinor + childPreserve;

    const estimateMinor = convertMinor(pot.monthlyEstimateMinor, pot.currency, displayCurrency, rateMap);
    const concreteActivity = directExpensesMinor + directScheduledMinor + directPreserveMinor + childEffectiveSum;

    const effectiveTotal = pot.envelopeMode ? Math.max(estimateMinor, concreteActivity) : concreteActivity;
    const unallocatedEnvelope = pot.envelopeMode ? Math.max(0, estimateMinor - concreteActivity) : 0;

    return {
      pot,
      estimateDisplayMinor: estimateMinor,
      itemizedSpendDisplayMinor: totalItemized,
      scheduledDueDisplayMinor: totalScheduled,
      preserveSliceDisplayMinor: totalPreserve,
      effectiveTotalDisplayMinor: effectiveTotal,
      unallocatedEnvelopeDisplayMinor: unallocatedEnvelope,
      children,
    };
  };

  return (byParent.get(null) ?? []).map(buildNode);
}

export interface HorizonProjectionPoint {
  yearOffset: number;
  year: number;
  propertyMinor: number;
  vehiclesAndBelongingsMinor: number;
  liquidAndInvestmentsMinor: number;
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  netWorthMinor: number;
}

/**
 * Long-Horizon Wealth & Belongings Forecast Engine (0..horizonYears):
 * - Appreciating assets (House) compound by +annualRateBp
 * - Depreciating belongings (Car, Moto, E-MTB, PC) decline by -annualRateBp down to residualFloorMinor
 * - Mortgages & loans amortize monthly principal based on APR and monthlyPaymentMinor
 * - Net monthly cash savings accumulate into Liquid Cash & Investments
 */
export function projectWealthHorizon(params: {
  startYear: number;
  horizonYears: number;
  assets: AssetBelongingRecord[];
  liabilities: LiabilityRecord[];
  bankCashDisplayMinor: number;
  monthlyNetSavingsDisplayMinor: number;
  displayCurrency: CurrencyCode;
  rateMap: Record<CurrencyCode, number>;
}): HorizonProjectionPoint[] {
  const {
    startYear,
    horizonYears,
    assets,
    liabilities,
    bankCashDisplayMinor,
    monthlyNetSavingsDisplayMinor,
    displayCurrency,
    rateMap,
  } = params;

  const assetStates = assets.map((a) => ({
    assetClass: a.assetClass,
    curveModel: a.curveModel,
    rate: a.annualRateBp / 10000,
    initialMinor: convertMinor(a.currentValueMinor, a.currency, displayCurrency, rateMap),
    currentMinor: convertMinor(a.currentValueMinor, a.currency, displayCurrency, rateMap),
    floorMinor: convertMinor(a.residualFloorMinor, a.currency, displayCurrency, rateMap),
  }));

  const liabStates = liabilities.map((l) => ({
    balanceMinor: convertMinor(l.balanceMinor, l.currency, displayCurrency, rateMap),
    monthlyRate: l.aprBp / 10000 / 12,
    monthlyPaymentMinor: convertMinor(l.monthlyPaymentMinor, l.currency, displayCurrency, rateMap),
  }));

  let accumulatedCash = bankCashDisplayMinor;
  const points: HorizonProjectionPoint[] = [];

  for (let y = 0; y <= horizonYears; y++) {
    let propertyMinor = 0;
    let vehiclesAndBelongingsMinor = 0;
    let liquidAndInvestmentsMinor = Math.max(0, accumulatedCash);

    for (const a of assetStates) {
      if (a.assetClass === 'property') propertyMinor += a.currentMinor;
      else if (a.assetClass === 'vehicle' || a.assetClass === 'belonging') vehiclesAndBelongingsMinor += a.currentMinor;
      else liquidAndInvestmentsMinor += a.currentMinor;
    }

    const totalAssetsMinor = propertyMinor + vehiclesAndBelongingsMinor + liquidAndInvestmentsMinor;
    const totalLiabilitiesMinor = liabStates.reduce((s, l) => s + Math.max(0, Math.round(l.balanceMinor)), 0);

    points.push({
      yearOffset: y,
      year: startYear + y,
      propertyMinor: Math.round(propertyMinor),
      vehiclesAndBelongingsMinor: Math.round(vehiclesAndBelongingsMinor),
      liquidAndInvestmentsMinor: Math.round(liquidAndInvestmentsMinor),
      totalAssetsMinor: Math.round(totalAssetsMinor),
      totalLiabilitiesMinor,
      netWorthMinor: Math.round(totalAssetsMinor - totalLiabilitiesMinor),
    });

    // Advance 1 year forward for next iteration
    for (const a of assetStates) {
      if (a.curveModel === 'compound_annual') {
        a.currentMinor = Math.max(a.floorMinor, a.currentMinor * (1 + a.rate));
      } else if (a.curveModel === 'linear_annual') {
        a.currentMinor = Math.max(a.floorMinor, a.currentMinor + a.initialMinor * a.rate);
      }
    }

    for (let m = 0; m < 12; m++) {
      for (const l of liabStates) {
        if (l.balanceMinor <= 0) continue;
        const interest = l.balanceMinor * l.monthlyRate;
        const pay = l.monthlyPaymentMinor > 0 ? l.monthlyPaymentMinor : 0;
        l.balanceMinor = Math.max(0, l.balanceMinor + interest - pay);
      }
      accumulatedCash += monthlyNetSavingsDisplayMinor;
    }
  }

  return points;
}

/**
 * Historical Wealth Reconstruction Engine (-pastYears..-1):
 * Reconstructs year-by-year historical Assets, Liabilities (reverse mortgage amortization),
 * and Net Worth prior to `startYear`, blending any stored `wealth_snapshots` when available.
 */
export function reconstructWealthHistory(params: {
  startYear: number;
  pastYears: number;
  assets: AssetBelongingRecord[];
  liabilities: LiabilityRecord[];
  bankCashDisplayMinor: number;
  monthlyNetSavingsDisplayMinor: number;
  displayCurrency: CurrencyCode;
  rateMap: Record<CurrencyCode, number>;
}): HorizonProjectionPoint[] {
  const {
    startYear,
    pastYears,
    assets,
    liabilities,
    bankCashDisplayMinor,
    monthlyNetSavingsDisplayMinor,
    displayCurrency,
    rateMap,
  } = params;

  if (pastYears <= 0) return [];

  const assetStates = assets.map((a) => {
    const curVal = convertMinor(a.currentValueMinor, a.currency, displayCurrency, rateMap);
    const purchVal = convertMinor(a.purchasePriceMinor, a.currency, displayCurrency, rateMap);
    return {
      assetClass: a.assetClass,
      rate: a.annualRateBp / 10000,
      currentMinor: curVal,
      maxCapMinor: purchVal > curVal ? purchVal : Math.round(curVal * 1.45),
    };
  });

  const liabStates = liabilities.map((l) => {
    const bal = convertMinor(l.balanceMinor, l.currency, displayCurrency, rateMap);
    const pmt = convertMinor(l.monthlyPaymentMinor, l.currency, displayCurrency, rateMap);
    const r = l.aprBp / 10000 / 12;
    // If monthlyPaymentMinor was not filled in, estimate a standard 25-year amortization payment
    const effectivePmt = pmt > 0 ? pmt : Math.round(bal * (r + 1 / 300));
    return {
      balanceMinor: bal,
      monthlyRate: r,
      monthlyPaymentMinor: effectivePmt,
    };
  });

  let histCash = bankCashDisplayMinor;
  const reversePoints: HorizonProjectionPoint[] = [];

  for (let yBack = 1; yBack <= pastYears; yBack++) {
    // Step 1 year backward
    for (const a of assetStates) {
      if (a.rate >= 0) {
        const effRate = Math.max(0.03, a.rate);
        a.currentMinor = a.currentMinor / (1 + effRate);
      } else {
        // Depreciating vehicle/belonging was worth more closer to purchase, capped at purchase price
        const depRate = Math.min(0.2, Math.abs(a.rate));
        a.currentMinor = Math.min(a.maxCapMinor, a.currentMinor * (1 + depRate * 0.6));
      }
    }

    for (let m = 0; m < 12; m++) {
      for (const l of liabStates) {
        if (l.balanceMinor <= 0 && l.monthlyPaymentMinor <= 0) continue;
        // Inverse of `nextBal = bal * (1 + r) - pay` -> `bal = (nextBal + pay) / (1 + r)`
        l.balanceMinor = (l.balanceMinor + l.monthlyPaymentMinor) / (1 + l.monthlyRate);
      }
      histCash = Math.max(0, histCash - Math.round(monthlyNetSavingsDisplayMinor * 0.45));
    }

    let propertyMinor = 0;
    let vehiclesAndBelongingsMinor = 0;
    let liquidAndInvestmentsMinor = Math.max(0, Math.round(histCash));

    for (const a of assetStates) {
      if (a.assetClass === 'property') propertyMinor += a.currentMinor;
      else if (a.assetClass === 'vehicle' || a.assetClass === 'belonging') vehiclesAndBelongingsMinor += a.currentMinor;
      else liquidAndInvestmentsMinor += a.currentMinor;
    }

    const totalAssetsMinor = Math.round(propertyMinor + vehiclesAndBelongingsMinor + liquidAndInvestmentsMinor);
    const totalLiabilitiesMinor = liabStates.reduce((s, l) => s + Math.max(0, Math.round(l.balanceMinor)), 0);

    reversePoints.push({
      yearOffset: -yBack,
      year: startYear - yBack,
      propertyMinor: Math.round(propertyMinor),
      vehiclesAndBelongingsMinor: Math.round(vehiclesAndBelongingsMinor),
      liquidAndInvestmentsMinor: Math.round(liquidAndInvestmentsMinor),
      totalAssetsMinor,
      totalLiabilitiesMinor,
      netWorthMinor: totalAssetsMinor - totalLiabilitiesMinor,
    });
  }

  return reversePoints.reverse();
}
