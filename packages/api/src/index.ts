import './instrument';
import { createApp } from './app';
import { config, getDb, shutdownOtel } from '@ledger/shared';

const db = getDb();
const app = createApp(db);

const server = app.listen(config.api.port, () => {
  console.log(`API listening on port ${config.api.port}`);
});

const shutdown = () => {
  server.close(async () => {
    await shutdownOtel();
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
