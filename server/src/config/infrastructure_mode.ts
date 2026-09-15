export type InfrastructureMode = 'local' | 'aws';

export type InfrastructureEnvironment = Record<string, string | undefined>;

/**
 * Infrastructure topology is independent from NODE_ENV. A compiled production
 * build can therefore be demonstrated on one machine without contacting AWS
 * infrastructure services.
 */
export function getInfrastructureMode(
  env: InfrastructureEnvironment = process.env,
): InfrastructureMode {
  const mode = (env.SENTINEL_INFRASTRUCTURE_MODE || 'local').trim().toLowerCase();
  if (mode !== 'local' && mode !== 'aws') {
    throw new Error('SENTINEL_INFRASTRUCTURE_MODE must be either local or aws');
  }
  return mode;
}

export function usesAwsInfrastructure(
  env: InfrastructureEnvironment = process.env,
): boolean {
  return getInfrastructureMode(env) === 'aws';
}

/** Local mode owns cadence in-process; AWS mode delegates it to EventBridge/SQS. */
export function shouldRunEmbeddedEvaluator(
  env: InfrastructureEnvironment = process.env,
): boolean {
  if (env.RUN_EMBEDDED_EVALUATOR === 'true') return true;
  if (env.RUN_EMBEDDED_EVALUATOR === 'false') return false;
  return getInfrastructureMode(env) === 'local';
}
