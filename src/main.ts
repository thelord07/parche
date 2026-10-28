import { ConfigError, loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const app = await buildServer(config);

  const stop = async (): Promise<void> => {
    await app.close();
  };

  process.on('SIGINT', () => {
    void stop().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void stop().then(() => process.exit(0));
  });

  try {
    await app.listen({ port: config.port, host: config.host });
    if (config.logLevel !== 'silent') {
      console.error(`parche listening on ${config.host}:${config.port}`);
    }
  } catch (err) {
    console.error('failed to start server:', err);
    process.exit(1);
  }
}

void main();
