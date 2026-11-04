#!/usr/bin/env node
/**
 * Skyday Finance — Local Stdio MCP Connector Bridge
 * Connects Antigravity / Claude / Codex over MCP stdio to https://finance.skyday.eu/api/mcp
 * using a local mode-restricted Bearer API key file (~/.gemini/secrets/skyday-finance-mcp.token),
 * plus supports `attach_receipt_file` to upload receipt screenshots/PDFs directly from disk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const BASE_URL = (process.env.SKYDAY_FINANCE_URL || 'https://finance.skyday.eu').replace(/\/+$/, '');
const TOKEN_FILE =
  process.env.SKYDAY_FINANCE_TOKEN_FILE ||
  path.join(os.homedir(), '.gemini', 'secrets', 'skyday-finance-mcp.token');

function loadToken() {
  if (process.env.SKYDAY_FINANCE_TOKEN) return process.env.SKYDAY_FINANCE_TOKEN.trim();
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  throw new Error(`Missing Skyday Finance MCP token at ${TOKEN_FILE}`);
}

const LOCAL_ATTACH_TOOL = {
  name: 'attach_receipt_file',
  description:
    'Attach a local receipt photo, screenshot, or invoice PDF file from disk onto an expense, obligation, asset, or liability in Skyday Finance.',
  inputSchema: {
    type: 'object',
    required: ['filePath', 'entityType', 'entityId'],
    properties: {
      filePath: { type: 'string', description: 'Absolute local path to the image or PDF receipt' },
      workspaceId: { type: 'string', description: 'ws-home, ws-wadera, or ws-walter (default: ws-home)' },
      entityType: { type: 'string', enum: ['expense', 'obligation', 'asset', 'liability', 'income'] },
      entityId: { type: 'string', description: 'ID returned by log_expense_receipt or list_upcoming_obligations' },
      label: { type: 'string', description: 'Optional receipt label' },
    },
  },
};

function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

async function callRemoteRpc(rpcReq) {
  const token = loadToken();
  const res = await fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(rpcReq),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Remote MCP HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return await res.json();
}

async function uploadLocalAttachment(args) {
  const token = loadToken();
  const filePath = String(args.filePath || '');
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const blob = new Blob([bytes], { type: mimeFromExt(filePath) });

  const form = new FormData();
  form.append('workspaceId', String(args.workspaceId || 'ws-home'));
  form.append('entityType', String(args.entityType || 'expense'));
  form.append('entityId', String(args.entityId));
  if (args.label) form.append('label', String(args.label));
  form.append('file', blob, fileName);

  const res = await fetch(`${BASE_URL}/api/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Attachment upload HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const out = await res.json();
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ attached: true, attachmentId: out.id, fileName, entityId: args.entityId }),
      },
    ],
  };
}

function sendJson(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const isNotification = msg.id === undefined;

  if (isNotification) {
    // Notifications (e.g. notifications/initialized) do not receive responses
    return;
  }

  try {
    if (msg.method === 'initialize') {
      const clientProto = msg.params?.protocolVersion || '2024-11-05';
      sendJson({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: clientProto,
          capabilities: { tools: {} },
          serverInfo: { name: 'skyday-finance', version: '1.0.0' },
        },
      });
      return;
    }

    if (msg.method === 'ping') {
      sendJson({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }

    if (msg.method === 'tools/list') {
      const remote = await callRemoteRpc(msg);
      const remoteTools = remote?.result?.tools || [];
      sendJson({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: [...remoteTools, LOCAL_ATTACH_TOOL] },
      });
      return;
    }

    if (msg.method === 'tools/call' && msg.params?.name === 'attach_receipt_file') {
      const result = await uploadLocalAttachment(msg.params.arguments || {});
      sendJson({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }

    const remoteResp = await callRemoteRpc(msg);
    sendJson(remoteResp);
  } catch (err) {
    sendJson({
      jsonrpc: '2.0',
      id: msg.id,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('Content-Length:')) return;
  try {
    const parsed = JSON.parse(trimmed);
    void handleMessage(parsed);
  } catch {
    // ignore malformed line
  }
});
