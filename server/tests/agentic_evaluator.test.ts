/**
 * Strands Sentinel - Agentic Condition Evaluator & Formalized Return Schema Test Suite
 * Tests autonomous AI agent evaluation, anti-hallucination guardrails,
 * Zod schema compliance, and end-to-end integration with EvaluatorEngine.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  AgenticConditionEvaluator,
  EvaluatorEngine,
} from '../src/services/evaluators/index.js';
import {
  AgenticEvaluationResultSchema,
  type Rule,
  type SubSentinel,
  type User,
} from '@sentinel/shared';
import {
  userRepository,
  ruleRepository,
  subSentinelRepository,
  interruptActionRepository,
} from '../src/db/index.js';

async function runTests() {
  console.log('🚀 Starting Sentinel Agentic Evaluator Test Suite...\n');

  const evaluator = new AgenticConditionEvaluator();

  // Test 1: Positive Condition Evaluation (Condition Met)
  console.log('--- Test 1: Agentic Condition Evaluation (Condition Met) ---');
  const positiveInput = {
    conditionToEvaluate: 'Alert if Tesla announces a new Gigafactory expansion in Mexico',
    targetSource: 'Automotive News Feed',
    observedContext: `
      BREAKING: Tesla has officially announced a $5 Billion expansion project to construct
      a new Gigafactory in Nuevo León, Mexico. CEO Elon Musk confirmed the facility will
      manufacture next-generation electric vehicles with operations commencing in 2026.
    `,
  };

  const positiveResult = await evaluator.evaluate(positiveInput);
  console.log('  Agentic Output:', JSON.stringify(positiveResult, null, 2));

  // Schema formalization check
  const positiveValidation = AgenticEvaluationResultSchema.safeParse(positiveResult);
  assert(positiveValidation.success, 'Output must strictly satisfy AgenticEvaluationResultSchema');
  assert.strictEqual(positiveResult.conditionSatisfied, true, 'Condition should be satisfied');
  assert(positiveResult.confidenceScore >= 0.7, 'Confidence score should be high for clear evidence');
  assert(positiveResult.reasoning.length > 0, 'Reasoning must be provided');
  assert(positiveResult.observedEvidence.relevantSnippet.length > 0, 'Evidence snippet must be extracted');
  assert(positiveResult.suggestedAlert != null, 'Suggested alert must be provided for satisfied condition');
  console.log('  ✔ Positive agentic evaluation verified with strict schema compliance');

  // Test 2: Negative Condition Evaluation (Condition Not Met / Anti-Hallucination)
  console.log('\n--- Test 2: Negative Condition Evaluation (Condition Not Met) ---');
  const negativeInput = {
    conditionToEvaluate: 'Alert if Apple announces acquisition of Netflix',
    targetSource: 'Financial Times Tech Wrap',
    observedContext: `
      Apple reported strong Q3 earnings today with services revenue reaching an all-time high
      of $24 billion. Meanwhile, Netflix shares gained 2% following strong subscriber additions
      driven by its ad-supported tier. Neither company commented on industry consolidation rumors.
    `,
  };

  const negativeResult = await evaluator.evaluate(negativeInput);
  console.log('  Agentic Output:', JSON.stringify(negativeResult, null, 2));

  const negativeValidation = AgenticEvaluationResultSchema.safeParse(negativeResult);
  assert(negativeValidation.success, 'Output must strictly satisfy AgenticEvaluationResultSchema');
  assert.strictEqual(negativeResult.conditionSatisfied, false, 'Condition must be false; no acquisition announced');
  assert(negativeResult.reasoning.toLowerCase().includes('neither') || negativeResult.reasoning.toLowerCase().includes('no') || negativeResult.reasoning.toLowerCase().includes('not'), 'Reasoning must explain lack of evidence');
  console.log('  ✔ Anti-hallucination guardrail verified');

  // Test 3: EvaluatorEngine Integration with Formalized Schema
  console.log('\n--- Test 3: EvaluatorEngine Integration with Formalized Schema ---');
  const testUser: User = {
    id: `agentic_user_${Date.now()}`,
    email: `agentic_${Date.now()}@sentinel.local`,
    name: 'Agentic Test User',
    google_sub: null,
    apple_sub: null,
    github_sub: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await userRepository.create(testUser);

  const engine = new EvaluatorEngine();

  const testRule: Rule = {
    id: randomUUID(),
    user_id: testUser.id,
    title: 'Nvidia Product Launch Alert',
    natural_language_intent: 'Notify me when Nvidia announces new Blackwell Ultra AI chips',
    category: 'WEB_INTEL',
    combinator: 'SINGLE',
    trigger_mode: 'ONE_SHOT',
    cooldown_minutes: 0,
    audio_tone: 'siren',
    status: 'ACTIVE',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await ruleRepository.create(testRule);

  // SubSentinel with embedded simulated data payload
  const subSentinel: SubSentinel = {
    id: randomUUID(),
    rule_id: testRule.id,
    sentinel_type: 'STREAM_INTELLIGENCE',
    target_source: 'Nvidia Blackwell Ultra',
    operator: 'SEMANTIC_MATCH',
    threshold: JSON.stringify({
      query: 'Nvidia Blackwell Ultra announcement',
      semanticFilter: 'Notify me when Nvidia announces new Blackwell Ultra AI chips',
    }),
    ttl_seconds: 300,
    health_status: 'HEALTHY',
    error_count: 0,
    is_satisfied: 0,
  };
  await subSentinelRepository.create(subSentinel);

  // Directly evaluate sub-sentinel via engine
  const evalResult = await engine.evaluateSubSentinel(subSentinel, testRule);
  console.log('  SubSentinel Evaluation Details:', evalResult.details);
  assert(typeof evalResult.isSatisfied === 'boolean');

  // Check that evaluation result metadata has formalized agentic result if evaluated
  if (evalResult.extraMetadata?.agenticResult) {
    const agentic = evalResult.extraMetadata.agenticResult as any;
    assert(AgenticEvaluationResultSchema.safeParse(agentic).success);
    console.log('  Formalized Agentic Result in SubSentinel extraMetadata verified');
  }

  console.log('\n🎉 ALL AGENTIC AI EVALUATOR TESTS COMPLETED SUCCESSFULLY!\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
