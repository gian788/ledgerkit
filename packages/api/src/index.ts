import { createApp } from './app.js';
import { config } from '@ledger/shared';

const app = createApp();

const server = app.listen(config.api.port, () => {
  console.log(`API listening on port ${config.api.port}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
