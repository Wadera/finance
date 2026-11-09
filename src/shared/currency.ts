import type { CurrencyCode, FxRateRecord } from './types.js';

export const DEFAULT_FX_RATES: FxRateRecord[] = [
  { currency: 'GBP', rateToGbp: 1.0, symbol: '£', updatedAt: '2026-11-04T00:00:00Z' },
  { currency: 'EUR', rateToGbp: 0.85, symbol: '€', updatedAt: '2026-11-04T00:00:00Z' },
  { currency: 'PLN', rateToGbp: 0.2, symbol: 'zł', updatedAt: '2026-11-04T00:00:00Z' },
  { currency: 'USD', rateToGbp: 0.79, symbol: '$', updatedAt: '2026-11-04T00:00:00Z' },
  { currency: 'CHF', rateToGbp: 0.9, symbol: 'CHF ', updatedAt: '2026-11-04T00:00:00Z' },
];

export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  GBP: '£',
  EUR: '€',
  PLN: 'zł',
  USD: '$',
  CHF: 'CHF ',
};

export function buildRateMap(rates: FxRateRecord[]): Record<CurrencyCode, number> {
  const map: Record<CurrencyCode, number> = {
    GBP: 1.0,
    EUR: 0.85,
    PLN: 0.2,
    USD: 0.79,
    CHF: 0.9,
  };
  for (const r of rates) {
    if (r.rateToGbp > 0) {
      map[r.currency] = r.rateToGbp;
    }
  }
  map.GBP = 1.0;
  return map;
}

export const rateMapFromList = buildRateMap;

/**
 * Deterministically converts integer minor units (e.g. cents/pence/grosze)
 * from `fromCurrency` into `toCurrency` via GBP pivot.
 */
export function convertMinor(
  amountMinor: number,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rateMap: Record<CurrencyCode, number>
): number {
  if (fromCurrency === toCurrency || amountMinor === 0) return Math.round(amountMinor);
  const fromToGbp = rateMap[fromCurrency] ?? 1.0;
  const toToGbp = rateMap[toCurrency] ?? 1.0;
  const gbpMinor = amountMinor * fromToGbp;
  return Math.round(gbpMinor / toToGbp);
}

export interface FormatMoneyOptions {
  currency: CurrencyCode;
  privacyMode: boolean;
  /** Reference denominator (e.g. monthly total income or total assets) in the same `currency` minor units */
  referenceTotalMinor?: number;
  /** Fallback label when privacyMode is active and no meaningful percentage denominator exists */
  privacyFallback?: string;
  compact?: boolean;
}

/**
 * Single zero-leak formatter across the entire UI.
 * When `privacyMode` is true, raw currency amounts are NEVER emitted —
 * only relative percentages (e.g. "18.4%") or masked badges ("•••").
 */
export function formatDisplayValue(amountMinor: number, opts: FormatMoneyOptions): string {
  if (opts.privacyMode) {
    if (opts.referenceTotalMinor && Math.abs(opts.referenceTotalMinor) > 0) {
      const pct = (amountMinor / Math.abs(opts.referenceTotalMinor)) * 100;
      const sign = pct < 0 ? '-' : '';
      const absPct = Math.abs(pct);
      return `${sign}${absPct >= 10 ? absPct.toFixed(1) : absPct.toFixed(1)}%`;
    }
    return opts.privacyFallback ?? '•••';
  }

  const sign = amountMinor < 0 ? '-' : '';
  const absMajor = Math.abs(amountMinor) / 100;
  const sym = CURRENCY_SYMBOLS[opts.currency] ?? `${opts.currency} `;

  if (opts.compact && absMajor >= 1000) {
    const formatted =
      absMajor >= 1_000_000
        ? `${(absMajor / 1_000_000).toFixed(2)}m`
        : `${(absMajor / 1_000).toFixed(absMajor >= 100_000 ? 0 : 1)}k`;
    return opts.currency === 'PLN' ? `${sign}${formatted} zł` : `${sign}${sym}${formatted}`;
  }

  const formatted = absMajor.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return opts.currency === 'PLN' ? `${sign}${formatted} zł` : `${sign}${sym}${formatted}`;
}

/**
 * Formats wealth trajectory points as Base-100 Index in Privacy Mode (e.g. "100.0" -> "118.4")
 */
export function formatIndexedWealth(
  currentMinor: number,
  baselineMinor: number,
  currency: CurrencyCode,
  privacyMode: boolean
): string {
  if (!privacyMode) {
    return formatDisplayValue(currentMinor, { currency, privacyMode: false, compact: true });
  }
  if (Math.abs(baselineMinor) === 0) return '100.0 idx';
  const idx = (currentMinor / Math.abs(baselineMinor)) * 100;
  return `${idx.toFixed(1)} idx`;
}
