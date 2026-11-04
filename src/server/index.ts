import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { loadAuthConfig, registerAuthRoutes } from './auth.js';
import { FinanceStore } from './db.js';
import { registerMcpRoutes } from './mcp.js';
import { registerApiRoutes } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const store = new FinanceStore();
  const authCfg = loadAuthConfig();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    trustProxy: true,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 20 * 1024 * 1024, // 20 MB max receipt/PDF size
    },
  });

  registerAuthRoutes(app, store, authCfg);
  registerApiRoutes(app, store, authCfg);
  registerMcpRoutes(app, store, authCfg);

  // Serve built Vite SPA in production
  const clientDist = path.resolve(__dirname, '../../public');
  if (fs.existsSync(clientDist)) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'API route not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3020);
  await app.listen({ host, port });
  app.log.info(`Skyday Finance listening on http://${host}:${port} (authMode=${authCfg.authMode})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
