import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildRateMap, convertMinor } from '../shared/currency.js';
import {
  buildPotBreadcrumbs,
  buildPotRollupTree,
  computeMonthlyIncomeMinor,
  computeObligationMonthMetrics,
  isObligationVisibleInMonth,
} from '../shared/financeEngine.js';
import type {
  CadenceKind,
  CurrencyCode,
  ExpenseSubItem,
  TransactionKind,
  TransactionStatus,
  UserProfile,
} from '../shared/types.js';
import { type AuthConfig, requireUser } from './auth.js';
import type { FinanceStore } from './db.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function resolveMinor(
  minorVal: unknown,
  majorVal: unknown
): number | undefined {
  if (minorVal !== undefined && minorVal !== null && minorVal !== '') {
    return Math.round(Number(minorVal));
  }
  if (majorVal !== undefined && majorVal !== null && majorVal !== '') {
    return Math.round(Number(majorVal) * 100);
  }
  return undefined;
}

export const MCP_TOOLS = [
  // 1. Account reads & balance snapshots
  {
    name: 'list_accounts',
    description:
      'List bank accounts with workspace, currency, booked balance, available balance, pending debits/credits, observation timestamp, source/evidence, last reconciliation, funded reserves, reserve underfunding shortfall, and pocket money allowance vs spendable cash.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'all, shared, personal, company, or a specific workspaceId (default: all)',
          default: 'all',
        },
        yearMonth: {
          type: 'string',
          description: 'YYYY-MM for pocket-money spend calculation (defaults to current month)',
        },
      },
    },
  },
  {
    name: 'get_account',
    description:
      'Get a single bank account with booked/available balances, pending debits/credits, observation metadata, reserve funding/shortfall, and pocket money status.',
    inputSchema: {
      type: 'object',
      required: ['accountId'],
      properties: {
        accountId: { type: 'string' },
        yearMonth: { type: 'string', description: 'YYYY-MM (defaults to current month)' },
      },
    },
  },
  {
    name: 'set_account_balance_snapshot',
    description:
      'Record an account balance observation snapshot without creating fake income or expense transactions. Patches only supplied fields and preserves existing notes, workspace, routing, currency, and metadata.',
    inputSchema: {
      type: 'object',
      required: ['accountId'],
      properties: {
        accountId: { type: 'string' },
        availableBalanceMinor: { type: 'number', description: 'Available balance in minor units (e.g. pence)' },
        availableBalanceMajor: { type: 'number', description: 'Available balance in major units (e.g. 133.44)' },
        bookedBalanceMinor: { type: 'number', description: 'Optional ledger/booked balance in minor units' },
        bookedBalanceMajor: { type: 'number', description: 'Optional ledger/booked balance in major units' },
        pendingDebitMinor: { type: 'number', description: 'Optional total pending debit authorizations in minor units' },
        pendingCreditMinor: { type: 'number', description: 'Optional total pending credit authorizations in minor units' },
        observedAt: { type: 'string', description: 'ISO-8601 timestamp when balance was observed' },
        source: { type: 'string', description: 'Observation source (e.g. bank_screenshot, statement)' },
        evidence: { type: 'string', description: 'Evidence reference or screenshot filename' },
        reconciled: { type: 'boolean', default: true },
        notes: { type: 'string', description: 'Optional note update; omit to preserve existing notes' },
        expectedVersion: { type: 'number', description: 'Optional optimistic concurrency version' },
      },
    },
  },

  // 2. Queryable transaction ledger
  {
    name: 'list_transactions',
    description:
      'Query the transaction ledger with account, workspace, date, yearMonth, status (pending/posted/reversed/refunded), kind (expense/deposit/transfer), merchant, and amount filters, with stable pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', default: 'all' },
        accountId: { type: 'string' },
        potId: { type: 'string', description: 'Pot ID or "uncategorized"' },
        yearMonth: { type: 'string', description: 'YYYY-MM' },
        fromDate: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        toDate: { type: 'string', description: 'YYYY-MM-DD inclusive' },
        status: {
          type: 'string',
          enum: ['pending', 'posted', 'reversed', 'refunded'],
        },
        kind: {
          type: 'string',
          enum: ['expense', 'deposit', 'transfer'],
        },
        flowDirection: {
          type: 'string',
          enum: ['outflow', 'inflow'],
        },
        merchantQuery: { type: 'string' },
        amountMinor: { type: 'number' },
        transferId: { type: 'string' },
        limit: { type: 'number', default: 100 },
        offset: { type: 'number', default: 0 },
      },
    },
  },
  {
    name: 'get_transaction',
    description: 'Get a single transaction by ID with full metadata and attached receipts.',
    inputSchema: {
      type: 'object',
      required: ['transactionId'],
      properties: {
        transactionId: { type: 'string' },
      },
    },
  },

  // 3. Transaction correction & import
  {
    name: 'upsert_transaction',
    description:
      'Create, update, reclassify, or promote a transaction (pending/posted/reversed/refunded). Supports idempotencyKey and providerTxId deduplication, exact bankTimestamp or dateOnly representation, and delta-only balance updates so promoting pending to posted or moving dates never double-debits available cash.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Existing transaction ID to update' },
        workspaceId: { type: 'string', description: 'ws-home, ws-wadera, or ws-walter' },
        accountId: { type: 'string' },
        potId: { type: ['string', 'null'], description: 'Category pot ID, or null for uncategorized' },
        liabilityId: { type: ['string', 'null'] },
        flowDirection: { type: 'string', enum: ['outflow', 'inflow'] },
        kind: { type: 'string', enum: ['expense', 'deposit', 'transfer'] },
        status: { type: 'string', enum: ['pending', 'posted', 'reversed', 'refunded'] },
        merchant: { type: 'string' },
        description: { type: 'string' },
        amountMinor: { type: 'number' },
        amountMajor: { type: 'number' },
        currency: { type: 'string', enum: ['GBP', 'EUR', 'PLN', 'USD', 'CHF'] },
        originalAmountMinor: { type: 'number' },
        originalCurrency: { type: 'string', enum: ['GBP', 'EUR', 'PLN', 'USD', 'CHF'] },
        fxRate: { type: 'number' },
        feeMinor: { type: 'number' },
        spentDate: { type: 'string', description: 'YYYY-MM-DD or ISO timestamp' },
        bankTimestamp: { type: ['string', 'null'], description: 'Exact bank timestamp (e.g. 2026-11-04T21:17:00Z)' },
        dateOnly: { type: 'boolean', description: 'Set true when exact time of day is unknown' },
        observedAt: { type: 'string' },
        reference: { type: 'string' },
        evidence: { type: 'string' },
        providerTxId: { type: 'string' },
        idempotencyKey: { type: 'string' },
        balanceEffect: {
          type: 'string',
          enum: ['auto', 'apply', 'none'],
          description: 'Use "none" when importing historical/pending records already reflected in an account snapshot',
        },
        alreadyReflectedInSnapshot: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              subCategory: { type: 'string' },
              amountMinor: { type: 'number' },
              amountMajor: { type: 'number' },
            },
          },
        },
      },
    },
  },
  {
    name: 'delete_transaction',
    description: 'Delete a transaction and reverse its applied balance delta (or both legs if it is a transfer).',
    inputSchema: {
      type: 'object',
      required: ['transactionId'],
      properties: {
        transactionId: { type: 'string' },
        balanceEffect: { type: 'string', enum: ['auto', 'none'], default: 'auto' },
      },
    },
  },

  // 4. Atomic internal transfers
  {
    name: 'create_transfer',
    description:
      'Create an atomic internal transfer between bank accounts (or a multi-account salary distribution batch when `legs` is supplied), deducting from the source account and adding to the destination account(s) with no household income or spending inflation. Can also reconcile existing single-leg Deposit/Outflow entries into linked transfer legs.',
    inputSchema: {
      type: 'object',
      required: ['fromAccountId'],
      properties: {
        fromAccountId: { type: 'string' },
        toAccountId: { type: 'string', description: 'Destination account ID for a single transfer' },
        amountMinor: { type: 'number' },
        amountMajor: { type: 'number' },
        toAmountMinor: { type: 'number' },
        toAmountMajor: { type: 'number' },
        feeMinor: { type: 'number' },
        fxRate: { type: 'number' },
        transferDate: { type: 'string', description: 'YYYY-MM-DD or ISO timestamp' },
        bankTimestamp: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'posted'], default: 'posted' },
        description: { type: 'string' },
        reference: { type: 'string' },
        evidence: { type: 'string' },
        idempotencyKey: { type: 'string' },
        balanceEffect: {
          description: '"auto", "apply", "none", or { from: "apply"|"none", to: "apply"|"none" }',
        },
        reconcileExistingOutflowTxId: {
          type: 'string',
          description: 'Optional existing outflow transaction ID to convert into the debit leg',
        },
        reconcileExistingInflowTxId: {
          type: 'string',
          description: 'Optional existing Deposit/Refund inflow transaction ID to convert into the credit leg',
        },
        legs: {
          type: 'array',
          description: 'Optional multi-destination legs for distributing salary from one source account to multiple accounts',
          items: {
            type: 'object',
            required: ['toAccountId'],
            properties: {
              toAccountId: { type: 'string' },
              amountMinor: { type: 'number' },
              amountMajor: { type: 'number' },
              toAmountMinor: { type: 'number' },
               feeMinor: { type: 'number' },
              fxRate: { type: 'number' },
              description: { type: 'string' },
              reference: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'update_transfer',
    description: 'Update an atomic internal transfer and adjust source/destination account balances by the required delta.',
    inputSchema: {
      type: 'object',
      required: ['transferId'],
      properties: {
        transferId: { type: 'string' },
        fromAccountId: { type: 'string' },
        toAccountId: { type: 'string' },
        amountMinor: { type: 'number' },
        amountMajor: { type: 'number' },
        toAmountMinor: { type: 'number' },
        feeMinor: { type: 'number' },
        fxRate: { type: 'number' },
        transferDate: { type: 'string' },
        bankTimestamp: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'posted', 'reversed', 'refunded'] },
        description: { type: 'string' },
        reference: { type: 'string' },
        evidence: { type: 'string' },
        balanceEffect: { type: 'string', enum: ['auto', 'apply', 'none'] },
      },
    },
  },
  {
    name: 'delete_transfer',
    description: 'Delete an internal transfer and reverse both debit and credit leg balance effects.',
    inputSchema: {
      type: 'object',
      required: ['transferId'],
      properties: {
        transferId: { type: 'string' },
        balanceEffect: { type: 'string', enum: ['auto', 'none'], default: 'auto' },
      },
    },
  },
  {
    name: 'list_transfers',
    description: 'List linked internal transfers between accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', default: 'all' },
        accountId: { type: 'string' },
        yearMonth: { type: 'string' },
        fromDate: { type: 'string' },
        toDate: { type: 'string' },
      },
    },
  },

  // 5 & 6. Obligation payment events & finite/variable schedules
  {
    name: 'list_upcoming_obligations',
    description: 'List recurring bills, finite schedules, annual renewals, payment occurrences, and Preserve sinking-fund status.',
    inputSchema: {
      type: 'object',
      properties: {
        yearMonth: { type: 'string' },
        scope: { type: 'string', default: 'all' },
      },
    },
  },
  {
    name: 'mark_obligation_paid',
    description:
      'Record, update, or reverse an obligation payment event for a given YYYY-MM. Supports actual paid amount, bankDate (separate from recordedAt), source accountId, linkedTransactionId, evidence, idempotencyKey, and explicit balanceEffect. Retrying is idempotent and never advances the schedule or deducts balances twice.',
    inputSchema: {
      type: 'object',
      required: ['obligationId'],
      properties: {
        obligationId: { type: 'string' },
        yearMonth: { type: 'string', description: 'YYYY-MM (defaults to the obligation nextDueDate month)' },
        paid: { type: 'boolean', default: true, description: 'Set false to reverse/unmark a payment event' },
        amountMinor: { type: 'number', description: 'Actual paid amount in minor units' },
        amountMajor: { type: 'number', description: 'Actual paid amount in major units (e.g. 75.45)' },
        bankDate: { type: 'string', description: 'Actual bank payment date or timestamp (preserved separately from recordedAt)' },
        accountId: { type: 'string', description: 'Source bank account ID' },
        linkedTransactionId: { type: 'string', description: 'Optional linked ledger transaction ID' },
        evidence: { type: 'string' },
        notes: { type: 'string' },
        idempotencyKey: { type: 'string' },
        balanceEffect: {
          type: 'string',
          enum: ['auto', 'apply', 'none'],
          default: 'auto',
        },
      },
    },
  },
  {
    name: 'update_obligation_schedule',
    description:
      'Update future obligation schedule parameters, final installment amount (finalAmountMinor / finalAmountMajor), endDate, remainingPayments, or per-month futureInstances without rewriting historical paid occurrences.',
    inputSchema: {
      type: 'object',
      required: ['obligationId'],
      properties: {
        obligationId: { type: 'string' },
        amountMinor: { type: 'number' },
        amountMajor: { type: 'number' },
        finalAmountMinor: { type: ['number', 'null'], description: 'Final installment amount in minor units (e.g. 7525 for £75.25)' },
        finalAmountMajor: { type: ['number', 'null'], description: 'Final installment amount in major units (e.g. 75.25)' },
        endDate: { type: ['string', 'null'], description: 'Final schedule date YYYY-MM-DD after which the obligation closes' },
        remainingPayments: { type: ['number', 'null'] },
        nextDueDate: { type: 'string' },
        dueDay: { type: 'number' },
        cadence: { type: 'string', enum: ['once', 'weekly', 'monthly', 'quarterly', 'biannual', 'annual', 'custom_months'] },
        intervalMonths: { type: 'number' },
        isActive: { type: 'boolean' },
        notes: { type: 'string' },
        futureInstances: {
          type: 'array',
          description: 'Optional per-month overrides for upcoming months (historical paid months are never altered)',
          items: {
            type: 'object',
            required: ['yearMonth'],
            properties: {
              yearMonth: { type: 'string' },
              dueDate: { type: 'string' },
              expectedMinor: { type: 'number' },
              expectedMajor: { type: 'number' },
              status: { type: 'string', enum: ['upcoming', 'skipped'] },
              notes: { type: 'string' },
            },
          },
        },
      },
    },
  },

  // 7. Actual budget & runway data
  {
    name: 'get_monthly_budget',
    description:
      'Get monthly budget, actual posted spend, pending authorizations, remaining budget, actual cash by account, paid/unpaid bills, expected income, funded reserves, reserve underfunding shortfall, and spendable pocket allowance capped by available account cash.',
    inputSchema: {
      type: 'object',
      properties: {
        yearMonth: { type: 'string', description: 'YYYY-MM (defaults to current month)' },
        scope: { type: 'string', default: 'all' },
      },
    },
  },

  // 8. Safe reconciliation batch
  {
    name: 'reconcile_batch',
    description:
      'Preview (dryRun: true) or atomically apply (dryRun: false) a reconciliation batch of account snapshots, transfers, transactions, obligation payments, and schedule updates with precondition checks, duplicate detection, unresolved evidence reporting, idempotency, and reversible audit log.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', default: false },
        idempotencyKey: { type: 'string' },
        snapshotMode: {
          type: 'string',
          enum: ['apply_deltas', 'already_reflected_in_snapshot'],
          default: 'apply_deltas',
        },
        expectedAccounts: { type: 'array', items: { type: 'object' } },
        accountSnapshots: { type: 'array', items: { type: 'object' } },
        transfers: { type: 'array', items: { type: 'object' } },
        transactions: { type: 'array', items: { type: 'object' } },
        obligationPayments: { type: 'array', items: { type: 'object' } },
        obligationSchedules: { type: 'array', items: { type: 'object' } },
        assertAfterAccounts: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'reverse_reconciliation_batch',
    description: 'Atomically reverse a previously applied reconciliation batch using its stored undo log.',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      properties: {
        batchId: { type: 'string' },
      },
    },
  },

  // Existing pot & receipt tools
  {
    name: 'list_pots',
    description:
      'List all accessible spending pots (including unlimited-depth nested sub-pots with full breadcrumb paths like Home & Utilities › Food & Groceries › Butcher & Meat) so receipts can be categorized accurately.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'all, shared, personal, company, or a specific workspaceId (e.g. ws-home, ws-company-a)',
          default: 'all',
        },
      },
    },
  },
  {
    name: 'create_pot',
    description:
      'Create a new spending pot or nested sub-pot at any depth under parentId, with optional rough monthly envelope estimate.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        workspaceId: { type: 'string', description: 'ws-home, ws-wadera, or ws-walter (inherits from parentId if omitted)' },
        parentId: { type: 'string', description: 'Optional parent pot ID for unlimited nesting' },
        name: { type: 'string' },
        monthlyEstimateMajor: { type: 'number', description: 'Optional rough monthly envelope amount (0 for pure container)' },
        currency: { type: 'string', enum: ['GBP', 'EUR', 'PLN', 'USD', 'CHF'] },
      },
    },
  },
  {
    name: 'log_expense_receipt',
    description:
      'Save a categorized receipt/invoice or itemized shopping spend into a specific pot (e.g. from a receipt photo or screenshot). Returns expenseId so you can optionally attach the image via attach_receipt_base64.',
    inputSchema: {
      type: 'object',
      required: ['workspaceId', 'merchant', 'amountMajor'],
      properties: {
        workspaceId: { type: 'string', description: 'ws-home, ws-wadera, or ws-walter' },
        accountId: { type: 'string', description: 'Optional bank account ID' },
        potId: { type: 'string', description: 'Target pot ID from list_pots' },
        status: { type: 'string', enum: ['pending', 'posted'], default: 'posted' },
        merchant: { type: 'string' },
        description: { type: 'string' },
        amountMajor: { type: 'number', description: 'Total receipt amount in major units (e.g. 42.50)' },
        currency: { type: 'string', enum: ['GBP', 'EUR', 'PLN', 'USD', 'CHF'], default: 'GBP' },
        spentDate: { type: 'string', description: 'YYYY-MM-DD or ISO timestamp' },
        bankTimestamp: { type: 'string' },
        idempotencyKey: { type: 'string' },
        balanceEffect: { type: 'string', enum: ['auto', 'apply', 'none'], default: 'auto' },
        tags: { type: 'array', items: { type: 'string' } },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'amountMajor'],
            properties: {
              name: { type: 'string' },
              subCategory: { type: 'string' },
              amountMajor: { type: 'number' },
            },
          },
        },
      },
    },
  },
  {
    name: 'attach_receipt_base64',
    description:
      'Attach a receipt image or invoice PDF (base64-encoded) onto an expense, obligation, asset, or liability.',
    inputSchema: {
      type: 'object',
      required: ['entityType', 'entityId', 'fileName', 'mimeType', 'dataBase64'],
      properties: {
        workspaceId: { type: 'string', description: 'ws-home, ws-wadera, or ws-walter' },
        entityType: { type: 'string', enum: ['expense', 'obligation', 'asset', 'liability', 'income'] },
        entityId: { type: 'string', description: 'Target record ID (e.g. expenseId from log_expense_receipt)' },
        fileName: { type: 'string', description: 'e.g. receipt-2026-11-04.jpg' },
        mimeType: { type: 'string', description: 'e.g. image/jpeg, image/png, application/pdf' },
        dataBase64: { type: 'string', description: 'Raw base64 file bytes (without data: URI prefix)' },
        label: { type: 'string' },
      },
    },
  },
];

export function executeSingleRpc(
  rpc: JsonRpcRequest,
  user: UserProfile,
  store: FinanceStore
): Record<string, unknown> | null {
  // JSON-RPC notifications (no 'id' property) expect no response object
  if (rpc.id === undefined) {
    return null;
  }

  const id = rpc.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const okJson = (payload: unknown) =>
    ok({
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    });
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (rpc.method === 'initialize') {
    const clientVersion =
      typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : '2025-03-26';
    return ok({
      protocolVersion: clientVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'skyday-finance-mcp', version: '1.2.0' },
    });
  }

  if (rpc.method === 'ping') {
    return ok({});
  }

  if (rpc.method === 'tools/list') {
    return ok({ tools: MCP_TOOLS });
  }

  if (rpc.method === 'tools/call') {
    const params = (rpc.params || {}) as { name?: string; arguments?: Record<string, unknown> };
    const toolArgs = params.arguments || {};
    const rateMap = buildRateMap(store.getFxRates());

    try {
      // -----------------------------------------------------------------------
      // 1. Account reads & balance snapshots
      // -----------------------------------------------------------------------
      if (params.name === 'list_accounts') {
        const scope = String(toolArgs.scope || 'all');
        const ym = toolArgs.yearMonth ? String(toolArgs.yearMonth) : undefined;
        const wsIds = store.readableWorkspaceIds(user.id, scope);
        const accounts = store.listAccountsEnriched(wsIds, ym).map((a) => ({
          ...a,
          availableBalanceMajor: a.availableBalanceMinor / 100,
          bookedBalanceMajor: a.bookedBalanceMinor / 100,
          lockedPreserveMajor: a.lockedPreserveMinor / 100,
          fundedPreserveMajor: a.fundedPreserveMinor / 100,
          unfundedPreserveShortfallMajor: a.unfundedPreserveShortfallMinor / 100,
          trueAvailableMajor: a.trueAvailableMinor / 100,
          pocketMoneyAllowanceRemainingMajor: a.pocketMoneyAllowanceRemainingMinor / 100,
          spendablePocketMoneyMajor: a.spendablePocketMoneyMinor / 100,
        }));
        return okJson({ workspaces: wsIds, accounts });
      }

      if (params.name === 'get_account') {
        const accountId = String(toolArgs.accountId || '');
        const ym = toolArgs.yearMonth ? String(toolArgs.yearMonth) : undefined;
        const acc = store.getAccountEnriched(accountId, ym);
        if (!acc || !store.canReadWorkspaceItems(user.id, acc.workspaceId)) {
          return err(-32001, `Account ${accountId} not found or read denied`);
        }
        return okJson({
          account: {
            ...acc,
            availableBalanceMajor: acc.availableBalanceMinor / 100,
            bookedBalanceMajor: acc.bookedBalanceMinor / 100,
            lockedPreserveMajor: acc.lockedPreserveMinor / 100,
            fundedPreserveMajor: acc.fundedPreserveMinor / 100,
            unfundedPreserveShortfallMajor: acc.unfundedPreserveShortfallMinor / 100,
            trueAvailableMajor: acc.trueAvailableMinor / 100,
            pocketMoneyAllowanceRemainingMajor: acc.pocketMoneyAllowanceRemainingMinor / 100,
            spendablePocketMoneyMajor: acc.spendablePocketMoneyMinor / 100,
          },
        });
      }

      if (params.name === 'set_account_balance_snapshot') {
        const accountId = String(toolArgs.accountId || '');
        const existing = store.getAccountById(accountId);
        if (!existing || !store.canWriteWorkspace(user.id, existing.workspaceId)) {
          return err(-32001, `Account ${accountId} not found or write denied`);
        }
        const availMinor = resolveMinor(
          toolArgs.availableBalanceMinor ?? toolArgs.balanceMinor,
          toolArgs.availableBalanceMajor ?? toolArgs.balanceMajor
        );
        const bookedMinor = resolveMinor(toolArgs.bookedBalanceMinor, toolArgs.bookedBalanceMajor);

        const res = store.setAccountBalanceSnapshot({
          accountId,
          availableBalanceMinor: availMinor,
          bookedBalanceMinor: bookedMinor,
          pendingDebitMinor:
            toolArgs.pendingDebitMinor !== undefined
              ? toolArgs.pendingDebitMinor != null
                ? Number(toolArgs.pendingDebitMinor)
                : null
              : undefined,
          pendingCreditMinor:
            toolArgs.pendingCreditMinor !== undefined
              ? toolArgs.pendingCreditMinor != null
                ? Number(toolArgs.pendingCreditMinor)
                : null
              : undefined,
          observedAt: toolArgs.observedAt ? String(toolArgs.observedAt) : undefined,
          source: toolArgs.source ? String(toolArgs.source) : undefined,
          evidence: toolArgs.evidence ? String(toolArgs.evidence) : undefined,
          reconciled: toolArgs.reconciled !== undefined ? Boolean(toolArgs.reconciled) : true,
          notes: typeof toolArgs.notes === 'string' ? toolArgs.notes : undefined,
          expectedVersion:
            toolArgs.expectedVersion !== undefined ? Number(toolArgs.expectedVersion) : undefined,
        });
        return okJson({
          ok: true,
          before: res.before,
          after: res.after,
          account: store.getAccountEnriched(accountId),
        });
      }

      // -----------------------------------------------------------------------
      // 2. Queryable transaction ledger
      // -----------------------------------------------------------------------
      if (params.name === 'list_transactions') {
        const scope = String(toolArgs.scope || (toolArgs.workspaceId as string) || 'all');
        const wsIds = store.readableWorkspaceIds(user.id, scope);
        const result = store.listTransactions({
          workspaceIds: wsIds,
          accountId: toolArgs.accountId ? String(toolArgs.accountId) : undefined,
          potId: toolArgs.potId ? String(toolArgs.potId) : undefined,
          yearMonth: toolArgs.yearMonth ? String(toolArgs.yearMonth) : undefined,
          fromDate: toolArgs.fromDate ? String(toolArgs.fromDate) : undefined,
          toDate: toolArgs.toDate ? String(toolArgs.toDate) : undefined,
          status: toolArgs.status as TransactionStatus | TransactionStatus[] | undefined,
          kind: toolArgs.kind as TransactionKind | TransactionKind[] | undefined,
          flowDirection: toolArgs.flowDirection as 'outflow' | 'inflow' | undefined,
          merchantQuery: toolArgs.merchantQuery ? String(toolArgs.merchantQuery) : undefined,
          amountMinor: resolveMinor(toolArgs.amountMinor, toolArgs.amountMajor),
          transferId: toolArgs.transferId ? String(toolArgs.transferId) : undefined,
          limit: toolArgs.limit !== undefined ? Number(toolArgs.limit) : undefined,
          offset: toolArgs.offset !== undefined ? Number(toolArgs.offset) : undefined,
        });
        return okJson({ ...result, total: result.totalCount });
      }

      if (params.name === 'get_transaction') {
        const txId = String(toolArgs.transactionId || toolArgs.id || '');
        const tx = store.getExpenseById(txId);
        if (!tx || !store.canReadWorkspaceItems(user.id, tx.workspaceId)) {
          return err(-32001, `Transaction ${txId} not found or read denied`);
        }
        return okJson({
          transaction: tx,
          attachments: store.listAttachments([tx.workspaceId], 'expense', tx.id),
        });
      }

      // -----------------------------------------------------------------------
      // 3. Transaction correction & import
      // -----------------------------------------------------------------------
      if (
        params.name === 'upsert_transaction' ||
        params.name === 'create_transaction' ||
        params.name === 'update_transaction'
      ) {
        const txId = toolArgs.id
          ? String(toolArgs.id)
          : toolArgs.transactionId
            ? String(toolArgs.transactionId)
            : undefined;
        const existing = store.findExistingTransaction({
          id: txId,
          idempotencyKey: toolArgs.idempotencyKey ? String(toolArgs.idempotencyKey) : null,
          providerTxId: toolArgs.providerTxId ? String(toolArgs.providerTxId) : null,
        });
        const accRec = toolArgs.accountId ? store.getAccountById(String(toolArgs.accountId)) : null;
        const wsId = String(
          toolArgs.workspaceId || existing?.workspaceId || accRec?.workspaceId || user.personalWorkspaceId
        );
        if (!store.canWriteWorkspace(user.id, wsId)) {
          return err(-32001, `Write denied for workspace ${wsId}`);
        }

        const amountMinor = resolveMinor(toolArgs.amountMinor, toolArgs.amountMajor);
        const rawItems = Array.isArray(toolArgs.items) ? (toolArgs.items as Array<Record<string, unknown>>) : undefined;
        const items: ExpenseSubItem[] | undefined = rawItems?.map((it, idx) => ({
          id: String(it.id || `mcp-item-${idx + 1}`),
          name: String(it.name || 'Item'),
          subCategory: it.subCategory ? String(it.subCategory) : null,
          amountMinor: resolveMinor(it.amountMinor, it.amountMajor) ?? 0,
        }));

        const res = store.upsertTransaction({
          id: txId,
          workspaceId: wsId,
          potId:
            toolArgs.potId !== undefined ? (toolArgs.potId ? String(toolArgs.potId) : null) : undefined,
          accountId:
            toolArgs.accountId !== undefined
              ? toolArgs.accountId
                ? String(toolArgs.accountId)
                : null
              : undefined,
          liabilityId:
            toolArgs.liabilityId !== undefined
              ? toolArgs.liabilityId
                ? String(toolArgs.liabilityId)
                : null
              : undefined,
          flowDirection: toolArgs.flowDirection as 'outflow' | 'inflow' | undefined,
          kind: toolArgs.kind as TransactionKind | undefined,
          status: toolArgs.status as TransactionStatus | undefined,
          merchant: toolArgs.merchant !== undefined ? String(toolArgs.merchant) : undefined,
          description: toolArgs.description !== undefined ? String(toolArgs.description) : undefined,
          amountMinor,
          currency: toolArgs.currency ? (String(toolArgs.currency) as CurrencyCode) : undefined,
          originalAmountMinor:
            toolArgs.originalAmountMinor !== undefined
              ? toolArgs.originalAmountMinor != null
                ? Number(toolArgs.originalAmountMinor)
                : null
              : undefined,
          originalCurrency:
            toolArgs.originalCurrency !== undefined
              ? toolArgs.originalCurrency
                ? (String(toolArgs.originalCurrency) as CurrencyCode)
                : null
              : undefined,
          fxRate:
            toolArgs.fxRate !== undefined ? (toolArgs.fxRate != null ? Number(toolArgs.fxRate) : null) : undefined,
          feeMinor:
            toolArgs.feeMinor !== undefined ? (toolArgs.feeMinor != null ? Number(toolArgs.feeMinor) : null) : undefined,
          spentDate: toolArgs.spentDate ? String(toolArgs.spentDate) : undefined,
          bankTimestamp:
            toolArgs.bankTimestamp !== undefined
              ? toolArgs.bankTimestamp
                ? String(toolArgs.bankTimestamp)
                : null
              : undefined,
          dateOnly: toolArgs.dateOnly === true,
          observedAt: toolArgs.observedAt ? String(toolArgs.observedAt) : undefined,
          reference: toolArgs.reference !== undefined ? (toolArgs.reference ? String(toolArgs.reference) : null) : undefined,
          evidence: toolArgs.evidence !== undefined ? (toolArgs.evidence ? String(toolArgs.evidence) : null) : undefined,
          providerTxId:
            toolArgs.providerTxId !== undefined
              ? toolArgs.providerTxId
                ? String(toolArgs.providerTxId)
                : null
              : undefined,
          idempotencyKey:
            toolArgs.idempotencyKey !== undefined
              ? toolArgs.idempotencyKey
                ? String(toolArgs.idempotencyKey)
                : null
              : undefined,
          tags: Array.isArray(toolArgs.tags) ? (toolArgs.tags as string[]) : undefined,
          source: 'mcp',
          items,
          balanceEffect: toolArgs.balanceEffect as 'auto' | 'apply' | 'none' | undefined,
          alreadyReflectedInSnapshot: toolArgs.alreadyReflectedInSnapshot === true,
        });

        return okJson({ ok: true, ...res });
      }

      if (params.name === 'delete_transaction') {
        const txId = String(toolArgs.transactionId || toolArgs.id || '');
        const existing = store.getExpenseById(txId);
        if (!existing || !store.canWriteWorkspace(user.id, existing.workspaceId)) {
          return err(-32001, `Transaction ${txId} not found or write denied`);
        }
        const res = store.deleteTransaction(txId, {
          balanceEffect: (toolArgs.balanceEffect as 'auto' | 'none') || 'auto',
        });
        return okJson({ ok: true, ...res });
      }

      // -----------------------------------------------------------------------
      // 4. Atomic internal transfers
      // -----------------------------------------------------------------------
      if (params.name === 'create_transfer') {
        const fromAccId = String(toolArgs.fromAccountId || '');
        const fromAcc = store.getAccountById(fromAccId);
        if (!fromAcc || !store.canWriteWorkspace(user.id, fromAcc.workspaceId)) {
          return err(-32001, `Source account ${fromAccId} not found or write denied`);
        }

        if (Array.isArray(toolArgs.legs) && toolArgs.legs.length > 0) {
          const legs = (toolArgs.legs as Array<Record<string, unknown>>).map((leg) => ({
            toAccountId: String(leg.toAccountId || ''),
            amountMinor: resolveMinor(leg.amountMinor, leg.amountMajor) ?? 0,
            toAmountMinor: resolveMinor(leg.toAmountMinor, leg.toAmountMajor),
            feeMinor: leg.feeMinor !== undefined ? Number(leg.feeMinor) : undefined,
            fxRate: leg.fxRate !== undefined ? (leg.fxRate != null ? Number(leg.fxRate) : null) : undefined,
            description: leg.description ? String(leg.description) : undefined,
            reference: leg.reference ? String(leg.reference) : undefined,
          }));
          const batchRes = store.createTransferBatch({
            fromAccountId: fromAccId,
            transferDate: toolArgs.transferDate ? String(toolArgs.transferDate) : undefined,
            bankTimestamp: toolArgs.bankTimestamp ? String(toolArgs.bankTimestamp) : undefined,
            status: (toolArgs.status as TransactionStatus) || 'posted',
            description: toolArgs.description ? String(toolArgs.description) : undefined,
            reference: toolArgs.reference ? String(toolArgs.reference) : undefined,
            idempotencyKey: toolArgs.idempotencyKey ? String(toolArgs.idempotencyKey) : undefined,
            legs,
          });
          return okJson({ ok: true, ...batchRes });
        }

        const toAccId = String(toolArgs.toAccountId || '');
        const toAcc = store.getAccountById(toAccId);
        if (!toAcc || !store.canWriteWorkspace(user.id, toAcc.workspaceId)) {
          return err(-32001, `Destination account ${toAccId} not found or write denied`);
        }

        const res = store.createTransfer({
          id: toolArgs.id ? String(toolArgs.id) : undefined,
          fromAccountId: fromAccId,
          toAccountId: toAccId,
          fromAmountMinor: resolveMinor(
            toolArgs.fromAmountMinor ?? toolArgs.amountMinor,
            toolArgs.fromAmountMajor ?? toolArgs.amountMajor
          ),
          toAmountMinor: resolveMinor(toolArgs.toAmountMinor, toolArgs.toAmountMajor),
          feeMinor: toolArgs.feeMinor !== undefined ? Number(toolArgs.feeMinor) : undefined,
          fxRate: toolArgs.fxRate !== undefined ? (toolArgs.fxRate != null ? Number(toolArgs.fxRate) : null) : undefined,
          transferDate: toolArgs.transferDate ? String(toolArgs.transferDate) : undefined,
          bankTimestamp: toolArgs.bankTimestamp ? String(toolArgs.bankTimestamp) : undefined,
          status: (toolArgs.status as TransactionStatus) || 'posted',
          description: toolArgs.description ? String(toolArgs.description) : undefined,
          reference: toolArgs.reference ? String(toolArgs.reference) : undefined,
          evidence: toolArgs.evidence ? String(toolArgs.evidence) : undefined,
          idempotencyKey: toolArgs.idempotencyKey ? String(toolArgs.idempotencyKey) : undefined,
          balanceEffect: toolArgs.balanceEffect as Parameters<typeof store.createTransfer>[0]['balanceEffect'],
          reconcileExistingOutflowTxId: toolArgs.reconcileExistingOutflowTxId
            ? String(toolArgs.reconcileExistingOutflowTxId)
            : undefined,
          reconcileExistingInflowTxId: toolArgs.reconcileExistingInflowTxId
            ? String(toolArgs.reconcileExistingInflowTxId)
            : undefined,
        });
        return okJson({ ok: true, ...res });
      }

      if (params.name === 'update_transfer') {
        const transferId = String(toolArgs.transferId || toolArgs.id || '');
        const existing = store.getTransferById(transferId);
        if (!existing || !store.canWriteWorkspace(user.id, existing.workspaceId)) {
          return err(-32001, `Transfer ${transferId} not found or write denied`);
        }
        const res = store.updateTransfer(transferId, {
          fromAccountId: toolArgs.fromAccountId ? String(toolArgs.fromAccountId) : undefined,
          toAccountId: toolArgs.toAccountId ? String(toolArgs.toAccountId) : undefined,
          fromAmountMinor: resolveMinor(
            toolArgs.fromAmountMinor ?? toolArgs.amountMinor,
            toolArgs.fromAmountMajor ?? toolArgs.amountMajor
          ),
          toAmountMinor: resolveMinor(toolArgs.toAmountMinor, toolArgs.toAmountMajor),
          feeMinor: toolArgs.feeMinor !== undefined ? Number(toolArgs.feeMinor) : undefined,
          fxRate: toolArgs.fxRate !== undefined ? (toolArgs.fxRate != null ? Number(toolArgs.fxRate) : null) : undefined,
          transferDate: toolArgs.transferDate ? String(toolArgs.transferDate) : undefined,
          bankTimestamp:
            toolArgs.bankTimestamp !== undefined
              ? toolArgs.bankTimestamp
                ? String(toolArgs.bankTimestamp)
                : null
              : undefined,
          status: toolArgs.status as TransactionStatus | undefined,
          description: toolArgs.description !== undefined ? String(toolArgs.description) : undefined,
          reference: toolArgs.reference !== undefined ? (toolArgs.reference ? String(toolArgs.reference) : null) : undefined,
          evidence: toolArgs.evidence !== undefined ? (toolArgs.evidence ? String(toolArgs.evidence) : null) : undefined,
          balanceEffect: toolArgs.balanceEffect as 'auto' | 'apply' | 'none' | undefined,
        });
        return okJson({ ok: true, ...res });
      }

      if (params.name === 'delete_transfer') {
        const transferId = String(toolArgs.transferId || toolArgs.id || '');
        const existing = store.getTransferById(transferId);
        if (!existing || !store.canWriteWorkspace(user.id, existing.workspaceId)) {
          return err(-32001, `Transfer ${transferId} not found or write denied`);
        }
        const res = store.deleteTransfer(transferId, {
          balanceEffect: (toolArgs.balanceEffect as 'auto' | 'none') || 'auto',
        });
        return okJson({ ok: true, ...res });
      }

      if (params.name === 'list_transfers') {
        const scope = String(toolArgs.scope || 'all');
        const wsIds = store.readableWorkspaceIds(user.id, scope);
        const transfers = store.listTransfers(wsIds, {
          accountId: toolArgs.accountId ? String(toolArgs.accountId) : undefined,
          yearMonth: toolArgs.yearMonth ? String(toolArgs.yearMonth) : undefined,
          fromDate: toolArgs.fromDate ? String(toolArgs.fromDate) : undefined,
          toDate: toolArgs.toDate ? String(toolArgs.toDate) : undefined,
        });
        return okJson({ transfers });
      }

      // -----------------------------------------------------------------------
      // 5 & 6. Obligation payment events & finite/variable schedules
      // -----------------------------------------------------------------------
      if (params.name === 'list_upcoming_obligations') {
        const ym = (toolArgs.yearMonth as string) || new Date().toISOString().slice(0, 7);
        const scope = String(toolArgs.scope || 'all');
        const wsIds = store.readableWorkspaceIds(user.id, scope);
        const rawObs = store.listObligations(wsIds);
        const occs = store.listPaymentOccurrences(
          ym,
          rawObs.map((o) => o.id)
        );
        const occByOb = new Map(occs.map((o) => [o.obligationId, o]));
        const allObs = rawObs.map((o) => {
          const occ = occByOb.get(o.id) ?? null;
          const metrics = computeObligationMonthMetrics(o, ym, occ);
          const visible = isObligationVisibleInMonth(o, ym, metrics, occ);
          return {
            ...o,
            finalAmountMajor: o.finalAmountMinor != null ? o.finalAmountMinor / 100 : null,
            occurrence: occ,
            isPaidThisMonth: occ?.status === 'paid',
            dueThisMonthMinor: metrics.dueThisMonthNativeMinor,
            dueThisMonthMajor: metrics.dueThisMonthNativeMinor / 100,
            isVisibleInMonth: visible,
            metrics,
          };
        });
        const obs = allObs.filter((o) => o.isVisibleInMonth);
        const archivedObligations = allObs.filter((o) => !o.isVisibleInMonth);
        return okJson({ yearMonth: ym, obligations: obs, archivedObligations });
      }

      if (params.name === 'mark_obligation_paid') {
        const obId = String(toolArgs.obligationId || '');
        const wsIds = store.readableWorkspaceIds(user.id, 'all');
        const ob = store.listObligations(wsIds).find((o) => o.id === obId);
        if (!ob || !store.canWriteWorkspace(user.id, ob.workspaceId)) {
          return err(-32002, 'Obligation not found or write denied');
        }
        const ym = toolArgs.yearMonth ? String(toolArgs.yearMonth) : ob.nextDueDate.slice(0, 7);
        const amountMinor = resolveMinor(toolArgs.amountMinor, toolArgs.amountMajor);
        const res = store.recordObligationPayment({
          obligationId: ob.id,
          yearMonth: ym,
          paid: toolArgs.paid !== false,
          amountMinor,
          bankDate: toolArgs.bankDate ? String(toolArgs.bankDate) : undefined,
          accountId:
            toolArgs.accountId !== undefined
              ? toolArgs.accountId
                ? String(toolArgs.accountId)
                : null
              : undefined,
          linkedTransactionId:
            toolArgs.linkedTransactionId !== undefined
              ? toolArgs.linkedTransactionId
                ? String(toolArgs.linkedTransactionId)
                : null
              : undefined,
          evidence: toolArgs.evidence ? String(toolArgs.evidence) : undefined,
          notes: toolArgs.notes ? String(toolArgs.notes) : 'Marked paid via MCP',
          idempotencyKey: toolArgs.idempotencyKey ? String(toolArgs.idempotencyKey) : undefined,
          balanceEffect: (toolArgs.balanceEffect as 'auto' | 'apply' | 'none') || 'auto',
        });

        return okJson({
          ok: true,
          obligationId: ob.id,
          occurrenceId: res.occurrence?.id ?? null,
          occurrence: res.occurrence,
          obligation: res.obligation,
          nextDueDate: res.obligation.nextDueDate,
          isActive: res.obligation.isActive,
          preservedResetToZero: res.obligation.preservedMinor === 0,
          accountBeforeBalanceMinor: res.accountBeforeBalanceMinor,
          accountAfterBalanceMinor: res.accountAfterBalanceMinor,
          idempotentReplay: res.idempotentReplay,
        });
      }

      if (params.name === 'update_obligation_schedule') {
        const obId = String(toolArgs.obligationId || '');
        const ob = store.getObligationById(obId);
        if (!ob || !store.canWriteWorkspace(user.id, ob.workspaceId)) {
          return err(-32002, 'Obligation not found or write denied');
        }
        const amountMinor = resolveMinor(toolArgs.amountMinor, toolArgs.amountMajor);
        const finalAmountMinor =
          toolArgs.finalAmountMinor === null || toolArgs.finalAmountMajor === null
            ? null
            : resolveMinor(toolArgs.finalAmountMinor, toolArgs.finalAmountMajor);
        const rawFuture = Array.isArray(toolArgs.futureInstances)
          ? (toolArgs.futureInstances as Array<Record<string, unknown>>)
          : undefined;
        const futureInstances = rawFuture?.map((f) => ({
          yearMonth: String(f.yearMonth),
          dueDate: f.dueDate ? String(f.dueDate) : undefined,
          expectedMinor: resolveMinor(f.expectedMinor, f.expectedMajor) ?? ob.amountMinor,
          status: (f.status === 'skipped' ? 'skipped' : 'upcoming') as 'upcoming' | 'skipped',
          notes: f.notes ? String(f.notes) : null,
        }));

        const res = store.updateObligationSchedule({
          obligationId: ob.id,
          amountMinor,
          finalAmountMinor,
          endDate:
            toolArgs.endDate !== undefined ? (toolArgs.endDate ? String(toolArgs.endDate) : null) : undefined,
          remainingPayments:
            toolArgs.remainingPayments !== undefined
              ? toolArgs.remainingPayments != null
                ? Number(toolArgs.remainingPayments)
                : null
              : undefined,
          nextDueDate: toolArgs.nextDueDate ? String(toolArgs.nextDueDate) : undefined,
          dueDay: toolArgs.dueDay !== undefined ? Number(toolArgs.dueDay) : undefined,
          cadence: toolArgs.cadence as CadenceKind | undefined,
          intervalMonths: toolArgs.intervalMonths !== undefined ? Number(toolArgs.intervalMonths) : undefined,
          isActive: toolArgs.isActive !== undefined ? Boolean(toolArgs.isActive) : undefined,
          notes: toolArgs.notes !== undefined ? (toolArgs.notes != null ? String(toolArgs.notes) : null) : undefined,
          futureInstances,
        });
        return okJson({ ok: true, ...res });
      }

      // -----------------------------------------------------------------------
      // 7. Actual budget & runway data
      // -----------------------------------------------------------------------
      if (params.name === 'get_monthly_budget') {
        const ym = (toolArgs.yearMonth as string) || new Date().toISOString().slice(0, 7);
        const scope = String(toolArgs.scope || 'all');
        const wsIds = store.readableWorkspaceIds(user.id, scope);
        const cur = user.defaultCurrency;

        const incomes = store.listIncomes(wsIds);
        const incomeOccs = store.listIncomeOccurrences(
          ym,
          incomes.map((i) => i.id)
        );
        const incOccById = new Map(incomeOccs.map((io) => [io.incomeId, io]));
        const pots = store.listPots(wsIds);
        const obligations = store.listObligations(wsIds);
        const occs = store.listPaymentOccurrences(
          ym,
          obligations.map((o) => o.id)
        );
        const occByOb = new Map(occs.map((o) => [o.obligationId, o]));
        const allMonthTx = store.listExpenses(wsIds, ym, ym);

        const activeOutflowExpenses = allMonthTx.filter(
          (e) =>
            e.flowDirection !== 'inflow' &&
            (e.kind ?? 'expense') !== 'transfer' &&
            (e.status ?? 'posted') !== 'reversed' &&
            (e.status ?? 'posted') !== 'refunded'
        );

        const postedSpendMinor = activeOutflowExpenses
          .filter((e) => (e.status ?? 'posted') !== 'pending')
          .reduce((s, e) => s + convertMinor(e.amountMinor, e.currency, cur, rateMap), 0);
        const pendingSpendMinor = activeOutflowExpenses
          .filter((e) => (e.status ?? 'posted') === 'pending')
          .reduce((s, e) => s + convertMinor(e.amountMinor, e.currency, cur, rateMap), 0);
        const totalItemizedSpendMinor = postedSpendMinor + pendingSpendMinor;

        let totalIncomeMinor = 0;
        let receivedIncomeMinor = 0;
        let expectedUntickedIncomeMinor = 0;
        for (const inc of incomes) {
          const m = computeMonthlyIncomeMinor(inc, ym, cur, rateMap);
          if (m <= 0) continue;
          totalIncomeMinor += m;
          const io = incOccById.get(inc.id);
          if (io && io.status === 'received') {
            receivedIncomeMinor += m;
          } else {
            expectedUntickedIncomeMinor += m;
          }
        }

        let paidBillsMinor = 0;
        let unpaidBillsMinor = 0;
        let preserveSliceMinor = 0;
        const obligationBreakdown = obligations
          .map((ob) => {
            const occ = occByOb.get(ob.id) ?? null;
            const m = computeObligationMonthMetrics(ob, ym, occ);
            const visible = isObligationVisibleInMonth(ob, ym, m, occ);
            if (!visible) return null;
            const isPaid = occ?.status === 'paid';
            const dueDisplay = convertMinor(m.dueThisMonthNativeMinor, ob.currency, cur, rateMap);
            const preserveDisplay = convertMinor(m.monthlyPreserveNativeMinor, ob.currency, cur, rateMap);
            if (m.isDueThisMonth) {
              if (isPaid) paidBillsMinor += dueDisplay;
              else unpaidBillsMinor += dueDisplay;
            } else if (preserveDisplay > 0) {
              preserveSliceMinor += preserveDisplay;
            }
            return {
              obligationId: ob.id,
              name: ob.name,
              potId: ob.potId,
              accountId: occ?.accountId ?? ob.accountId,
              cadence: ob.cadence,
              dueDay: ob.dueDay,
              nextDueDate: ob.nextDueDate,
              endDate: ob.endDate ?? null,
              finalAmountMinor: ob.finalAmountMinor ?? null,
              isActive: ob.isActive,
              isDueThisMonth: m.isDueThisMonth,
              isPaidThisMonth: isPaid,
              dueMinor: dueDisplay,
              preserveSliceMinor: preserveDisplay,
              effectiveBurdenMinor: convertMinor(m.effectiveMonthlyBurdenNativeMinor, ob.currency, cur, rateMap),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

        const tree = buildPotRollupTree(pots, obligations, activeOutflowExpenses, ym, cur, rateMap, occByOb);
        const unassignedExpensesMinor = activeOutflowExpenses
          .filter((e) => !e.potId)
          .reduce((s, e) => s + convertMinor(e.amountMinor, e.currency, cur, rateMap), 0);
        const unassignedObMinor = obligationBreakdown
          .filter((o) => !o.potId)
          .reduce((s, o) => s + o.effectiveBurdenMinor, 0);

        const potPlannedTotalMinor =
          tree.reduce((s, n) => s + n.effectiveTotalDisplayMinor, 0) + unassignedExpensesMinor + unassignedObMinor;

        const sumUnallocatedEnv = (node: (typeof tree)[number]): number =>
          node.unallocatedEnvelopeDisplayMinor + node.children.reduce((s, c) => s + sumUnallocatedEnv(c), 0);
        const remainingEnvelopeBudgetMinor = tree.reduce((s, n) => s + sumUnallocatedEnv(n), 0);
        const remainingMonthlyIncomeSurplusMinor = totalIncomeMinor - potPlannedTotalMinor;

        const enrichedAccounts = store.listAccountsEnriched(wsIds, ym);
        const totalAvailableCashMinor = enrichedAccounts.reduce(
          (s, a) => s + convertMinor(a.availableBalanceMinor, a.currency, cur, rateMap),
          0
        );
        const totalBookedCashMinor = enrichedAccounts.reduce(
          (s, a) => s + convertMinor(a.bookedBalanceMinor, a.currency, cur, rateMap),
          0
        );
        const plannedReservesMinor = enrichedAccounts.reduce(
          (s, a) => s + convertMinor(a.lockedPreserveMinor, a.currency, cur, rateMap),
          0
        );
        const fundedReservesMinor = enrichedAccounts.reduce(
          (s, a) => s + convertMinor(a.fundedPreserveMinor, a.currency, cur, rateMap),
          0
        );
        const reserveShortfallMinor = enrichedAccounts.reduce(
          (s, a) => s + convertMinor(a.unfundedPreserveShortfallMinor, a.currency, cur, rateMap),
          0
        );
        const totalSpendableCashMinor = enrichedAccounts.reduce(
          (s, a) => s + convertMinor(a.trueAvailableMinor, a.currency, cur, rateMap),
          0
        );

        const flattenTree = (nodes: typeof tree): Array<(typeof tree)[number]> => {
          const out: Array<(typeof tree)[number]> = [];
          for (const n of nodes) {
            out.push(n);
            out.push(...flattenTree(n.children));
          }
          return out;
        };
        const allPotNodes = flattenTree(tree);
        const mapPotNode = (n: (typeof tree)[number]) => ({
          id: n.pot.id,
          parentId: n.pot.parentId,
          name: n.pot.name,
          estimateMajor: n.estimateDisplayMinor / 100,
          postedSpendMajor: n.postedSpendDisplayMinor / 100,
          pendingSpendMajor: n.pendingSpendDisplayMinor / 100,
          itemizedSpendMajor: n.itemizedSpendDisplayMinor / 100,
          itemizedMajor: n.itemizedSpendDisplayMinor / 100,
          scheduledDueMajor: n.scheduledDueDisplayMinor / 100,
          preserveMajor: n.preserveSliceDisplayMinor / 100,
          unallocatedEnvelopeMajor: n.unallocatedEnvelopeDisplayMinor / 100,
          effectiveMajor: n.effectiveTotalDisplayMinor / 100,
          postedSpendMinor: n.postedSpendDisplayMinor,
          pendingSpendMinor: n.pendingSpendDisplayMinor,
          itemizedMinor: n.itemizedSpendDisplayMinor,
          unallocatedEnvelopeMinor: n.unallocatedEnvelopeDisplayMinor,
          effectiveMinor: n.effectiveTotalDisplayMinor,
        });

        return okJson({
          yearMonth: ym,
          currency: cur,
          totalIncomeMinor,
          totalIncomeMajor: totalIncomeMinor / 100,
          receivedIncomeMinor,
          expectedIncomeMinor: expectedUntickedIncomeMinor,
          spentMinor: postedSpendMinor,
          spentMajor: postedSpendMinor / 100,
          postedSpendMinor,
          postedSpendMajor: postedSpendMinor / 100,
          pendingMinor: pendingSpendMinor,
          pendingMajor: pendingSpendMinor / 100,
          pendingSpendMinor,
          pendingSpendMajor: pendingSpendMinor / 100,
          totalItemizedSpendMinor,
          totalItemizedSpendMajor: totalItemizedSpendMinor / 100,
          paidBillsMinor,
          paidBillsMajor: paidBillsMinor / 100,
          unpaidBillsMinor,
          unpaidBillsMajor: unpaidBillsMinor / 100,
          preserveSliceMinor,
          potPlannedTotalMinor,
          potPlannedTotalMajor: potPlannedTotalMinor / 100,
          remainingBudgetMinor: remainingEnvelopeBudgetMinor,
          remainingBudgetMajor: remainingEnvelopeBudgetMinor / 100,
          remainingMonthlyIncomeSurplusMinor,
          reserves: {
            plannedReservesMinor,
            plannedReservesMajor: plannedReservesMinor / 100,
            fundedReservesMinor,
            fundedReservesMajor: fundedReservesMinor / 100,
            reserveShortfallMinor,
            reserveShortfallMajor: reserveShortfallMinor / 100,
          },
          cash: {
            totalAvailableCashMinor,
            totalAvailableCashMajor: totalAvailableCashMinor / 100,
            totalBookedCashMinor,
            totalBookedCashMajor: totalBookedCashMinor / 100,
            totalSpendableCashMinor,
            totalSpendableCashMajor: totalSpendableCashMinor / 100,
          },
          accounts: enrichedAccounts.map((a) => ({
            id: a.id,
            accountId: a.id,
            workspaceId: a.workspaceId,
            name: a.name,
            institution: a.institution,
            currency: a.currency,
            availableBalanceMinor: a.availableBalanceMinor,
            availableBalanceMajor: a.availableBalanceMinor / 100,
            bookedBalanceMinor: a.bookedBalanceMinor,
            bookedBalanceMajor: a.bookedBalanceMinor / 100,
            pendingDebitMinor: a.pendingDebitMinor,
            pendingCreditMinor: a.pendingCreditMinor,
            plannedReserveMinor: a.lockedPreserveMinor,
            plannedReservesMajor: a.lockedPreserveMinor / 100,
            fundedReserveMinor: a.fundedPreserveMinor,
            fundedReservesMajor: a.fundedPreserveMinor / 100,
            reserveShortfallMinor: a.unfundedPreserveShortfallMinor,
            reserveShortfallMajor: a.unfundedPreserveShortfallMinor / 100,
            freeSpendableCashMinor: a.trueAvailableMinor,
            freeCashMajor: a.trueAvailableMinor / 100,
            pocketMoneyTargetMinor: a.pocketMoneyTargetMinor,
            pocketMoneySpentMinor: a.pocketMoneySpentMinor,
            pocketMoneyAllowanceRemainingMinor: a.pocketMoneyAllowanceRemainingMinor,
            pocketMoneyAllowanceRemainingMajor: a.pocketMoneyAllowanceRemainingMinor / 100,
            spendablePocketMoneyMinor: a.spendablePocketMoneyMinor,
            spendablePocketMoneyMajor: a.spendablePocketMoneyMinor / 100,
            observedAt: a.observedAt,
            lastReconciledAt: a.lastReconciledAt,
            notes: a.notes,
          })),
          obligations: obligationBreakdown,
          potSummary: tree.map(mapPotNode),
          potRollups: allPotNodes.map(mapPotNode),
        });
      }

      // -----------------------------------------------------------------------
      // 8. Safe reconciliation batch
      // -----------------------------------------------------------------------
      if (params.name === 'reconcile_batch') {
        const result = store.reconcileBatch(
          user.id,
          toolArgs as Parameters<typeof store.reconcileBatch>[1]
        );
        return okJson({ ok: true, ...result });
      }

      if (params.name === 'reverse_reconciliation_batch') {
        const batchId = String(toolArgs.batchId || '');
        if (!batchId) return err(-32602, 'batchId is required');
        const result = store.reverseReconciliationBatch(user.id, batchId);
        return okJson({ ok: true, ...result });
      }

      // -----------------------------------------------------------------------
      // Existing Pot & Receipt Tools
      // -----------------------------------------------------------------------
      if (params.name === 'list_pots') {
        const scope = (toolArgs.scope as 'all' | 'shared' | 'personal') || 'all';
        const wsIds = store.readableWorkspaceIds(user.id, scope);
        const rawPots = store.listPots(wsIds);
        const crumbs = buildPotBreadcrumbs(rawPots);
        const pots = rawPots.map((p) => {
          const c = crumbs.get(p.id);
          return {
            ...p,
            path: c?.pathString ?? p.name,
            depth: c?.depth ?? 0,
          };
        });
        return okJson({ workspaces: wsIds, pots });
      }

      if (params.name === 'create_pot') {
        const parentId = toolArgs.parentId ? String(toolArgs.parentId) : null;
        const parentRow = parentId
          ? (store.db
              .prepare(`SELECT workspace_id, color FROM pots WHERE id = ?`)
              .get(parentId) as { workspace_id: string; color: string } | undefined)
          : undefined;
        if (parentId && !parentRow) {
          return err(-32602, `Parent pot ${parentId} not found`);
        }
        const wsId = String(toolArgs.workspaceId || parentRow?.workspace_id || 'ws-home');
        if (!store.canWriteWorkspace(user.id, wsId)) {
          return err(-32001, `Write denied for workspace ${wsId}`);
        }
        const id = `pot-${crypto.randomUUID().slice(0, 8)}`;
        const estMinor = Math.max(0, Math.round(Number(toolArgs.monthlyEstimateMajor || 0) * 100));
        const cur = ((toolArgs.currency as CurrencyCode) || user.defaultCurrency) as CurrencyCode;
        const name = String(toolArgs.name || 'New Pot').trim();
        store.db
          .prepare(
            `INSERT INTO pots (id, workspace_id, parent_id, name, icon, color, envelope_mode, monthly_estimate_minor, currency, tags_json, sort_order)
             VALUES (?, ?, ?, ?, 'folder', ?, ?, ?, ?, '[]', 10)`
          )
          .run(id, wsId, parentId, name, parentRow?.color || '#2E6F7E', estMinor > 0 ? 1 : 0, estMinor, cur);
        return okJson({ ok: true, potId: id, parentId, workspaceId: wsId, name });
      }

      if (params.name === 'log_expense_receipt') {
        const workspaceId = String(toolArgs.workspaceId || user.personalWorkspaceId);
        if (!store.canWriteWorkspace(user.id, workspaceId)) {
          return err(-32001, `Write denied for workspace ${workspaceId}`);
        }
        const currency = ((toolArgs.currency as CurrencyCode) || user.defaultCurrency) as CurrencyCode;
        const amountMinor = Math.round(Number(toolArgs.amountMajor || 0) * 100);
        const spentDate = String(toolArgs.spentDate || new Date().toISOString().slice(0, 10));
        const rawItems = Array.isArray(toolArgs.items) ? (toolArgs.items as Array<Record<string, unknown>>) : [];
        const items: ExpenseSubItem[] = rawItems.map((it, idx) => ({
          id: `mcp-item-${idx + 1}`,
          name: String(it.name || 'Item'),
          subCategory: it.subCategory ? String(it.subCategory) : null,
          amountMinor: Math.round(Number(it.amountMajor || 0) * 100),
        }));

        const upserted = store.upsertTransaction({
          workspaceId,
          accountId: toolArgs.accountId ? String(toolArgs.accountId) : undefined,
          potId: toolArgs.potId ? String(toolArgs.potId) : null,
          status: (toolArgs.status as TransactionStatus) || 'posted',
          merchant: String(toolArgs.merchant || 'Receipt'),
          description: String(toolArgs.description || 'Logged via MCP'),
          amountMinor,
          currency,
          spentDate,
          bankTimestamp: toolArgs.bankTimestamp ? String(toolArgs.bankTimestamp) : undefined,
          idempotencyKey: toolArgs.idempotencyKey ? String(toolArgs.idempotencyKey) : undefined,
          balanceEffect: (toolArgs.balanceEffect as 'auto' | 'apply' | 'none') || 'auto',
          tags: Array.isArray(toolArgs.tags) ? (toolArgs.tags as string[]) : [],
          source: 'mcp',
          items,
        });

        const convertedMinor = convertMinor(amountMinor, currency, user.defaultCurrency, rateMap);
        return okJson({
          saved: true,
          expenseId: upserted.transaction.id,
          transaction: upserted.transaction,
          amountMajor: amountMinor / 100,
          currency,
          convertedDefaultMajor: convertedMinor / 100,
          defaultCurrency: user.defaultCurrency,
        });
      }

      if (params.name === 'attach_receipt_base64') {
        const workspaceId = String(toolArgs.workspaceId || 'ws-home');
        if (!store.canWriteWorkspace(user.id, workspaceId)) {
          return err(-32001, `Write denied for workspace ${workspaceId}`);
        }
        const rawB64 = String(toolArgs.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(rawB64, 'base64');
        if (!buf.byteLength || buf.byteLength > 20 * 1024 * 1024) {
          return err(-32602, 'Invalid or oversized attachment payload');
        }
        const origName = String(toolArgs.fileName || 'receipt.jpg');
        const mimeType = String(toolArgs.mimeType || 'image/jpeg');
        const entityType = String(toolArgs.entityType || 'expense');
        const entityId = String(toolArgs.entityId || '');
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        const attId = `att-${crypto.randomUUID().slice(0, 8)}`;
        const ext = path.extname(origName).slice(0, 10) || '.bin';
        const storedName = `${attId}-${sha256.slice(0, 12)}${ext}`;
        fs.writeFileSync(path.join(store.paths.attachmentsDir, storedName), buf);

        store.db
          .prepare(
            `INSERT INTO attachments (id, workspace_id, entity_type, entity_id, original_name, stored_name, mime_type, size_bytes, sha256, label, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            attId,
            workspaceId,
            entityType,
            entityId,
            origName,
            storedName,
            mimeType,
            buf.byteLength,
            sha256,
            toolArgs.label ? String(toolArgs.label) : null,
            new Date().toISOString()
          );

        return okJson({
          attached: true,
          attachmentId: attId,
          entityType,
          entityId,
          sizeBytes: buf.byteLength,
        });
      }

      return err(-32601, `Unknown tool: ${params.name}`);
    } catch (toolErr) {
      return err(-32000, toolErr instanceof Error ? toolErr.message : String(toolErr));
    }
  }

  return err(-32601, `Unsupported MCP method: ${rpc.method}`);
}

export function registerMcpRoutes(app: FastifyInstance, store: FinanceStore, cfg: AuthConfig): void {
  const handlePost = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(req, reply, store, cfg);
    if (!user) return;

    const body = req.body;
    if (Array.isArray(body)) {
      const responses = body
        .map((item) => executeSingleRpc(item as JsonRpcRequest, user, store))
        .filter((r): r is Record<string, unknown> => r !== null);
      if (responses.length === 0) {
        return reply.code(202).send();
      }
      return responses;
    }

    const single = executeSingleRpc((body || {}) as JsonRpcRequest, user, store);
    if (single === null) {
      return reply.code(202).send();
    }
    return single;
  };

  const handleGet = async (_req: FastifyRequest, reply: FastifyReply) => {
    // Stateless Streamable HTTP MCP per 2025-03-26 specification: POST-only JSON-RPC, no server-push SSE needed
    return reply.header('Allow', 'POST').code(405).send({
      error: 'Use POST with JSON-RPC 2.0 payload and Authorization: Bearer <token>',
    });
  };

  app.post('/api/mcp', handlePost);
  app.get('/api/mcp', handleGet);
  app.post('/mcp', handlePost);
  app.get('/mcp', handleGet);
}
