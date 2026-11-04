import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FX_RATES,
  buildRateMap,
  convertMinor,
  formatDisplayValue,
  formatIndexedWealth,
} from '../src/shared/currency.js';
import {
  applyObligationPaymentReset,
  buildPotRollupTree,
  computeMonthlyIncomeMinor,
  computeObligationMonthMetrics,
  projectWealthHorizon,
  resolveWaderaShareBp,
} from '../src/shared/financeEngine.js';
import type {
  AssetBelongingRecord,
  ExpenseEntryRecord,
  IncomeStreamRecord,
  LiabilityRecord,
  ObligationRecord,
  PotRecord,
} from '../src/shared/types.js';

describe('Multi-Currency & Friends Privacy Mode', () => {
  const rateMap = buildRateMap(DEFAULT_FX_RATES);

  it('converts EUR, PLN, USD, CHF deterministically to GBP and back', () => {
    // €100.00 (10000 minor) @ 0.85 -> £85.00 (8500 minor)
    expect(convertMinor(10000, 'EUR', 'GBP', rateMap)).toBe(8500);
    // 500.00 zł (50000 minor) @ 0.20 -> £100.00 (10000 minor)
    expect(convertMinor(50000, 'PLN', 'GBP', rateMap)).toBe(10000);
    // £85.00 -> €100.00
    expect(convertMinor(8500, 'GBP', 'EUR', rateMap)).toBe(10000);
  });

  it('never leaks currency symbols or nominal figures when privacyMode is enabled', () => {
    const normal = formatDisplayValue(120000, {
      currency: 'GBP',
      privacyMode: false,
      referenceTotalMinor: 600000,
    });
    expect(normal).toBe('£1,200.00');

    const maskedPct = formatDisplayValue(120000, {
      currency: 'GBP',
      privacyMode: true,
      referenceTotalMinor: 600000,
    });
    expect(maskedPct).toBe('20.0%');
    expect(maskedPct).not.toContain('£');
    expect(maskedPct).not.toContain('1,200');

    const maskedNoRef = formatDisplayValue(450000, {
      currency: 'GBP',
      privacyMode: true,
    });
    expect(maskedNoRef).toBe('•••');

    const idx = formatIndexedWealth(23680000, 20000000, 'GBP', true);
    expect(idx).toBe('118.4 idx');
    expect(idx).not.toContain('£');
  });
});

describe('Automatic Sinking-Fund ("Preserve") Engine', () => {
  const baseOb: ObligationRecord = {
    id: 'ob-ins',
    workspaceId: 'ws-wadera',
    potId: 'pot-car',
    name: 'Annual Car Insurance',
    amountMinor: 15000, // £150.00
    currency: 'GBP',
    cadence: 'annual',
    intervalMonths: 12,
    nextDueDate: '2027-02-15',
    dueDay: 15,
    preservedMinor: 0,
    autoPreserve: true,
    splitMode: 'owner_only',
    waderaSplitBp: 10000,
    tags: ['car', 'insurance'],
    manageUrl: 'https://admiral.com/manage',
    portalUrl: null,
    referenceNumber: 'POL-123',
    renewalNoticeDays: 30,
    notes: null,
    isActive: true,
  };

  it('budgets £50/month when £150 is due in 3 months, then resets to £12.50/month for 12-month cycle after payment', () => {
    // Nov 2026 -> Feb 2027 = 3 months until due -> £150 / 3 = £50.00/mo (5000 minor)
    const nov = computeObligationMonthMetrics(baseOb, '2026-11');
    expect(nov.monthsUntilDue).toBe(3);
    expect(nov.isDueThisMonth).toBe(false);
    expect(nov.monthlyPreserveNativeMinor).toBe(5000);
    expect(nov.effectiveMonthlyBurdenNativeMinor).toBe(5000);

    // Suppose £100 has been preserved by Jan 2027 (1 month left -> £50 remaining)
    const jan = computeObligationMonthMetrics({ ...baseOb, preservedMinor: 10000 }, '2027-01');
    expect(jan.monthsUntilDue).toBe(1);
    expect(jan.monthlyPreserveNativeMinor).toBe(5000);

    // Marked as Paid in Feb 2027 -> nextDueDate jumps to 2028-02-15, preservedMinor resets to 0
    const reset = applyObligationPaymentReset(baseOb);
    expect(reset.nextDueDate).toBe('2028-02-15');
    expect(reset.preservedMinor).toBe(0);
    expect(reset.isActive).toBe(true);

    // Next month cycle (Feb 2027 looking 12 months ahead to Feb 2028): £150 / 12 = £12.50/mo (1250 minor)
    const nextCycle = computeObligationMonthMetrics({ ...baseOb, ...reset }, '2027-02');
    expect(nextCycle.monthsUntilDue).toBe(12);
    expect(nextCycle.monthlyPreserveNativeMinor).toBe(1250);
  });
});

describe('Hierarchical Pot Envelope vs. Itemized Roll-Up', () => {
  const rateMap = buildRateMap(DEFAULT_FX_RATES);

  it('respects £600 rough food envelope without double counting partial itemized receipts, and expands if exceeded', () => {
    const pots: PotRecord[] = [
      {
        id: 'pot-house',
        workspaceId: 'ws-home',
        parentId: null,
        name: 'Household',
        icon: 'home',
        color: '#2E6F7E',
        envelopeMode: false,
        monthlyEstimateMinor: 0,
        currency: 'GBP',
        tags: [],
        sortOrder: 1,
      },
      {
        id: 'pot-food',
        workspaceId: 'ws-home',
        parentId: 'pot-house',
        name: 'Food & Groceries',
        icon: 'shopping-bag',
        color: '#3D7A5A',
        envelopeMode: true,
        monthlyEstimateMinor: 60000, // £600.00 rough monthly envelope
        currency: 'GBP',
        tags: ['groceries'],
        sortOrder: 1,
      },
      {
        id: 'pot-meat',
        workspaceId: 'ws-home',
        parentId: 'pot-food',
        name: 'Meat & Butcher',
        icon: 'utensils',
        color: '#C87D32',
        envelopeMode: false,
        monthlyEstimateMinor: 0,
        currency: 'GBP',
        tags: [],
        sortOrder: 1,
      },
    ];

    const expenses: ExpenseEntryRecord[] = [
      {
        id: 'exp-1',
        workspaceId: 'ws-home',
        potId: 'pot-meat',
        merchant: 'Local Butcher',
        description: 'Steak & poultry',
        amountMinor: 8500, // £85.00 itemized
        currency: 'GBP',
        spentDate: '2026-11-04',
        tags: ['food'],
        portalUrl: null,
        source: 'manual',
        items: [],
        createdAt: '2026-11-04T12:00:00Z',
      },
    ];

    const tree = buildPotRollupTree(pots, [], expenses, '2026-11', 'GBP', rateMap);
    expect(tree).toHaveLength(1);
    const house = tree[0];
    const food = house.children[0];

    expect(food.itemizedSpendDisplayMinor).toBe(8500);
    expect(food.unallocatedEnvelopeDisplayMinor).toBe(51500); // £515 remaining in £600 envelope
    expect(food.effectiveTotalDisplayMinor).toBe(60000); // £600 total, not £685!
    expect(house.effectiveTotalDisplayMinor).toBe(60000);
  });
});

describe('Shared Split & Long-Horizon Wealth Projection', () => {
  const rateMap = buildRateMap(DEFAULT_FX_RATES);

  it('computes income-proportional splits and projects appreciating house + depreciating car + mortgage amortization', () => {
    const shareBp = resolveWaderaShareBp('income_proportional', 5000, 600000, 400000);
    expect(shareBp).toBe(6000); // 60%

    const inc: IncomeStreamRecord = {
      id: 'inc-1',
      workspaceId: 'ws-wadera',
      name: 'Salary',
      sourceKind: 'salary',
      amountMinor: 550000,
      currency: 'GBP',
      cadence: 'monthly',
      paydayDay: 25,
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      isActive: true,
      portalUrl: null,
      notes: null,
    };
    expect(computeMonthlyIncomeMinor(inc, '2026-11', 'GBP', rateMap)).toBe(550000);

    const assets: AssetBelongingRecord[] = [
      {
        id: 'ast-house',
        workspaceId: 'ws-home',
        name: 'Family House',
        assetClass: 'property',
        purchaseDate: '2023-06-01',
        purchasePriceMinor: 42000000,
        currentValueMinor: 45000000, // £450,000
        currency: 'GBP',
        curveModel: 'compound_annual',
        annualRateBp: 350, // +3.5%/yr
        residualFloorMinor: 0,
        portalUrl: null,
        manageUrl: null,
        referenceNumber: null,
        notes: null,
        updatedAt: '2026-11-04T00:00:00Z',
      },
      {
        id: 'ast-car',
        workspaceId: 'ws-wadera',
        name: 'Car',
        assetClass: 'vehicle',
        purchaseDate: '2024-03-01',
        purchasePriceMinor: 2800000,
        currentValueMinor: 2200000, // £22,000
        currency: 'GBP',
        curveModel: 'compound_annual',
        annualRateBp: -1500, // -15%/yr depreciation
        residualFloorMinor: 400000, // £4,000 floor
        portalUrl: null,
        manageUrl: null,
        referenceNumber: null,
        notes: null,
        updatedAt: '2026-11-04T00:00:00Z',
      },
    ];

    const liabilities: LiabilityRecord[] = [
      {
        id: 'liab-mort',
        workspaceId: 'ws-home',
        linkedAssetId: 'ast-house',
        name: 'House Mortgage',
        kind: 'mortgage',
        balanceMinor: 29000000, // £290,000
        aprBp: 420, // 4.20% APR
        monthlyPaymentMinor: 165000, // £1,650/mo
        currency: 'GBP',
        endDate: '2048-06-01',
        portalUrl: null,
        referenceNumber: null,
        notes: null,
        updatedAt: '2026-11-04T00:00:00Z',
      },
    ];

    const points = projectWealthHorizon({
      startYear: 2026,
      horizonYears: 10,
      assets,
      liabilities,
      bankCashDisplayMinor: 1500000, // £15,000
      monthlyNetSavingsDisplayMinor: 100000, // £1,000/mo
      displayCurrency: 'GBP',
      rateMap,
    });

    expect(points).toHaveLength(11);
    expect(points[0].netWorthMinor).toBe(45000000 + 2200000 + 1500000 - 29000000);
    // Over 10 years: house appreciates, car depreciates (never below £4k floor), mortgage shrinks, net worth grows substantially
    expect(points[10].propertyMinor).toBeGreaterThan(points[0].propertyMinor);
    expect(points[10].vehiclesAndBelongingsMinor).toBeLessThan(points[0].vehiclesAndBelongingsMinor);
    expect(points[10].vehiclesAndBelongingsMinor).toBeGreaterThanOrEqual(400000);
    expect(points[10].totalLiabilitiesMinor).toBeLessThan(points[0].totalLiabilitiesMinor);
    expect(points[10].netWorthMinor).toBeGreaterThan(points[0].netWorthMinor);
  });
});
