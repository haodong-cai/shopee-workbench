import { createServer } from 'vite';
import { startServer } from './index.mjs';
const api = startServer();
const vite = await createServer();
await vite.listen();
vite.printUrls();
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await vite.close(); api.close(); });
