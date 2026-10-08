export type InfrastructureMode = 'local' | 'aws';

export type InfrastructureEnvironment = Record<string, string | undefined>;

/**
 * Infrastructure topology is explicit. Development defaults to local
 * infrastructure, while production defaults to AWS and is validated by the
 * production readiness contract.
 */
export function getInfrastructureMode(
  env: InfrastructureEnvironment = process.env,
): InfrastructureMode {
  const defaultMode = env.NODE_ENV === 'production' ? 'aws' : 'local';
  const mode = (env.SENTINEL_INFRASTRUCTURE_MODE || defaultMode).trim().toLowerCase();
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
  const mode = getInfrastructureMode(env);
  if (env.NODE_ENV === 'production') {
    if (mode !== 'aws') {
      throw new Error('Production requires AWS infrastructure; embedded evaluation is development-only');
    }
    if (env.RUN_EMBEDDED_EVALUATOR === 'true') {
      throw new Error('Production must not run the embedded evaluator');
    }
    return false;
  }
  if (env.RUN_EMBEDDED_EVALUATOR === 'true') return true;
  if (env.RUN_EMBEDDED_EVALUATOR === 'false') return false;
  return mode === 'local';
}
