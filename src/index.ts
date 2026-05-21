#!/usr/bin/env node
import { config } from 'dotenv';
import { ProductboardMCPServer } from '@core/server.js';
import { startHttpServer, HttpServerHandle } from '@core/http-server.js';
import { ConfigManager } from '@utils/config.js';
import { Logger } from '@utils/logger.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load environment variables
config();

function getVersion(): string {
  try {
    // dist/index.js lives one level below the project root after build.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, '..', 'package.json'), join(process.cwd(), 'package.json')];
    for (const path of candidates) {
      try {
        return JSON.parse(readFileSync(path, 'utf-8')).version || '0.0.0';
      } catch {
        // try next
      }
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

async function main(): Promise<void> {
  // First non-flag arg is the subcommand. Default 'stdio' preserves the
  // original local-MCP behaviour for Claude Desktop / Cursor users.
  const subcommand = (process.argv[2] || 'stdio').toLowerCase();

  const configManager = new ConfigManager();
  const configuration = configManager.get();

  const logger = new Logger({
    level: configuration.logLevel,
    pretty: configuration.logPretty,
  });

  try {
    const validation = configManager.validate();
    if (!validation.valid) {
      logger.fatal('Configuration validation failed', { errors: validation.errors });
      process.exit(1);
    }

    const server = await ProductboardMCPServer.create(configuration);
    await server.initialize();

    let httpHandle: HttpServerHandle | undefined;

    const shutdown = async (signal: string): Promise<void> => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      try {
        if (httpHandle) {
          await httpHandle.close();
        }
        await server.stop();
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    if (subcommand === 'serve' || subcommand === 'http') {
      // HTTP mode — for container deployment behind an ALB.
      httpHandle = await startHttpServer(server, logger, getVersion());
      logger.info(`Productboard MCP HTTP server ready on port ${httpHandle.port}`);
    } else {
      // stdio mode (default) — for Claude Desktop / Cursor local installation.
      await server.start();
      logger.info('Server is running. Press Ctrl+C to stop.');
    }
  } catch (error) {
    logger.fatal('Server startup failed', error);
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`Unhandled error: ${error}\n`);
  process.exit(1);
});
