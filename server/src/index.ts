/**
 * Strands Sentinel - Backend Server Entrypoint
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'),
  override: false,
});

export const config = {
  port: Number(process.env.PORT) || 8080,
  host: process.env.HOST || '0.0.0.0',
  databasePath: process.env.DATABASE_PATH || './data/sentinel.db',
  evaluatorIntervalMs: Number(process.env.EVALUATOR_INTERVAL_MS) || 30000,
};

async function main() {
  // These imports intentionally happen after dotenv initialization. Database
  // provider selection occurs during module evaluation and must see local env.
  const [
    { buildServer },
    { globalEvaluatorEngine },
    { assertProductionConfiguration },
    { getInfrastructureMode, shouldRunEmbeddedEvaluator },
  ] = await Promise.all([
    import('./server/app.js'),
    import('./services/evaluators/engine.js'),
    import('./config/production_readiness.js'),
    import('./config/infrastructure_mode.js'),
  ]);

  assertProductionConfiguration();
  const app = await buildServer();

  try {
    const address = await app.listen({
      port: config.port,
      host: config.host,
    });
    console.log(`⚡ Strands Sentinel Server listening at ${address}`);

    // Local mode owns cadence in this process. AWS mode can opt into the
    // EventBridge -> SQS worker plane independently of NODE_ENV.
    const infrastructureMode = getInfrastructureMode();
    const runEmbeddedEvaluator = shouldRunEmbeddedEvaluator();
    if (runEmbeddedEvaluator) {
      globalEvaluatorEngine.start(config.evaluatorIntervalMs);
      console.log(`🛡️ Embedded evaluator started (interval: ${config.evaluatorIntervalMs}ms)`);
    } else {
      console.log('🛡️ Embedded evaluator disabled; EventBridge/SQS worker owns scheduling');
    }
    console.log(`🏗️ Infrastructure mode: ${infrastructureMode}`);

    const shutdown = async () => {
      console.log('Shutting down server...');
      if (runEmbeddedEvaluator) globalEvaluatorEngine.stop();
      await app.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
