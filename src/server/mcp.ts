import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildRateMap, convertMinor } from '../shared/currency.js';
import {
  applyObligationPaymentReset,
  buildPotBreadcrumbs,
  buildPotRollupTree,
  computeMonthlyIncomeMinor,
  computeObligationMonthMetrics,
} from '../shared/financeEngine.js';
import type { CurrencyCode, ExpenseSubItem, UserProfile } from '../shared/types.js';
import { type AuthConfig, requireUser } from './auth.js';
import type { FinanceStore } from './db.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const MCP_TOOLS = [
  {
    name: 'list_pots',
    description:
      'List all accessible spending pots (including unlimited-depth nested sub-pots with full breadcrumb paths like Home & Utilities › Food & Groceries › Butcher & Meat) so receipts can be categorized accurately.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: "all, shared, personal, company, or a specific workspaceId (e.g. ws-home, ws-company-a)",
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
    name: 'get_monthly_budget',
    description:
      'Get monthly income, scheduled bills, automatic Preserve sinking-fund slices, pot roll-ups, and account sufficiency for YYYY-MM.',
    inputSchema: {
      type: 'object',
      properties: {
        yearMonth: { type: 'string', description: 'YYYY-MM (defaults to current month)' },
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
        potId: { type: 'string', description: 'Target pot ID from list_pots' },
        merchant: { type: 'string' },
        description: { type: 'string' },
        amountMajor: { type: 'number', description: 'Total receipt amount in major units (e.g. 42.50)' },
        currency: { type: 'string', enum: ['GBP', 'EUR', 'PLN', 'USD', 'CHF'], default: 'GBP' },
        spentDate: { type: 'string', description: 'YYYY-MM-DD' },
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
  {
    name: 'list_upcoming_obligations',
    description: 'List upcoming recurring bills, annual renewals, and Preserve sinking-fund status.',
    inputSchema: {
      type: 'object',
      properties: {
        yearMonth: { type: 'string' },
      },
    },
  },
  {
    name: 'mark_obligation_paid',
    description:
      'Tick a scheduled payment as paid for a given YYYY-MM, advancing nextDueDate and resetting its Preserve counter.',
    inputSchema: {
      type: 'object',
      required: ['obligationId', 'yearMonth'],
      properties: {
        obligationId: { type: 'string' },
        yearMonth: { type: 'string' },
      },
    },
  },
];

function executeSingleRpc(
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
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (rpc.method === 'initialize') {
    const clientVersion =
      typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : '2025-03-26';
    return ok({
      protocolVersion: clientVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'skyday-finance-mcp', version: '1.1.0' },
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
      return ok({
        content: [{ type: 'text', text: JSON.stringify({ workspaces: wsIds, pots }, null, 2) }],
      });
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
      return ok({
        content: [{ type: 'text', text: JSON.stringify({ ok: true, potId: id, parentId, workspaceId: wsId, name }) }],
      });
    }

    if (params.name === 'get_monthly_budget') {
      const ym = (toolArgs.yearMonth as string) || new Date().toISOString().slice(0, 7);
      const wsIds = store.readableWorkspaceIds(user.id, 'all');
      const incomes = store.listIncomes(wsIds);
      const pots = store.listPots(wsIds);
      const obligations = store.listObligations(wsIds);
      const expenses = store.listExpenses(wsIds, ym, ym);
      const totalIncomeMinor = incomes.reduce(
        (s, i) => s + computeMonthlyIncomeMinor(i, ym, user.defaultCurrency, rateMap),
        0
      );
      const tree = buildPotRollupTree(pots, obligations, expenses, ym, user.defaultCurrency, rateMap);
      return ok({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                yearMonth: ym,
                currency: user.defaultCurrency,
                totalIncomeMajor: totalIncomeMinor / 100,
                potSummary: tree.map((n) => ({
                  id: n.pot.id,
                  name: n.pot.name,
                  effectiveMajor: n.effectiveTotalDisplayMinor / 100,
                  itemizedMajor: n.itemizedSpendDisplayMinor / 100,
                  preserveMajor: n.preserveSliceDisplayMinor / 100,
                })),
              },
              null,
              2
            ),
          },
        ],
      });
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

      const expId = `exp-${crypto.randomUUID().slice(0, 8)}`;
      store.db
        .prepare(
          `INSERT INTO expenses (id, workspace_id, pot_id, merchant, description, amount_minor, currency, spent_date, tags_json, portal_url, source, items_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'mcp', ?, ?)`
        )
        .run(
          expId,
          workspaceId,
          toolArgs.potId ? String(toolArgs.potId) : null,
          String(toolArgs.merchant || 'Receipt'),
          String(toolArgs.description || 'Logged via MCP'),
          amountMinor,
          currency,
          spentDate,
          JSON.stringify(Array.isArray(toolArgs.tags) ? toolArgs.tags : []),
          JSON.stringify(items),
          new Date().toISOString()
        );

      const convertedMinor = convertMinor(amountMinor, currency, user.defaultCurrency, rateMap);
      return ok({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              saved: true,
              expenseId: expId,
              amountMajor: amountMinor / 100,
              currency,
              convertedDefaultMajor: convertedMinor / 100,
              defaultCurrency: user.defaultCurrency,
            }),
          },
        ],
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

      return ok({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ attached: true, attachmentId: attId, entityType, entityId, sizeBytes: buf.byteLength }),
          },
        ],
      });
    }

    if (params.name === 'list_upcoming_obligations') {
      const ym = (toolArgs.yearMonth as string) || new Date().toISOString().slice(0, 7);
      const wsIds = store.readableWorkspaceIds(user.id, 'all');
      const obs = store.listObligations(wsIds).map((o) => ({
        ...o,
        metrics: computeObligationMonthMetrics(o, ym),
      }));
      return ok({ content: [{ type: 'text', text: JSON.stringify(obs, null, 2) }] });
    }

    if (params.name === 'mark_obligation_paid') {
      const obId = String(toolArgs.obligationId || '');
      const ym = String(toolArgs.yearMonth || new Date().toISOString().slice(0, 7));
      const wsIds = store.readableWorkspaceIds(user.id, 'all');
      const ob = store.listObligations(wsIds).find((o) => o.id === obId);
      if (!ob || !store.canWriteWorkspace(user.id, ob.workspaceId)) {
        return err(-32002, 'Obligation not found or write denied');
      }
      const reset = applyObligationPaymentReset(ob);
      store.db
        .prepare(
          `INSERT INTO payment_occurrences (id, obligation_id, year_month, due_date, expected_minor, actual_paid_minor, currency, status, paid_at, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', ?, 'Marked paid via MCP')
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
      store.db
        .prepare(`UPDATE obligations SET next_due_date = ?, preserved_minor = ?, is_active = ? WHERE id = ?`)
        .run(reset.nextDueDate, reset.preservedMinor, reset.isActive ? 1 : 0, ob.id);

      return ok({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              obligationId: ob.id,
              nextDueDate: reset.nextDueDate,
              preservedResetToZero: true,
            }),
          },
        ],
      });
    }

    return err(-32601, `Unknown tool: ${params.name}`);
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
