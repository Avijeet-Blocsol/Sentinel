import { tool, type ToolContext } from '@strands-agents/sdk';
import { z } from 'zod';
import { SentinelOperatorEnum } from '@sentinel/shared';
import { DeepResearchHarness } from './harness.js';
import {
  TargetDataKindEnum,
  PreferredDomainsPolicyEnum,
  SourceCategoryEnum,
  type DeepResearchTask,
  type DeepResearchOutcome,
  type ResearchTelemetryEvent,
  type DeepResearchConfig,
} from './types.js';

/**
 * ==========================================================
 * SENTINEL DEEP RESEARCH META-HARNESS — PUBLIC ENTRY POINT
 * ==========================================================
 * Public module exports for Sentinel's autonomous web discovery harness.
 */

// 1. Export types & enums
export * from './types.js';

// 2. Export schemas
export * from './schemas.js';

// 3. Export security & SSRF prevention utilities
export {
  validateAndCanonicalizeUrl,
  safeResolveDns,
  verifyUrlOrigin,
  matchesDomainBoundary,
  isPrivateIp,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
} from './security/url_validator.js';

export { safeFetch } from './security/safe_fetch.js';

// 4. Export condition evaluation
export { evaluateCondition } from './condition_evaluator.js';

// 5. Export harness & graph pipeline
export { DeepResearchHarness } from './harness.js';
export {
  runResearchPipeline,
  createPlannerAgent,
  createScoutAgent,
  createInspectorAgent,
  createSynthesizerAgent,
  getDefaultModel,
  getModelForRole,
  extractJsonFromText,
  type AgentRole,
  type ResearchModel,
  type ResearchGraphOptions,
} from './research_graph.js';

// 6. Export tools & standalone functions
export {
  webSearchTool,
  executeWebSearch,
  sanitizeUrl,
  extractDomain,
  extractSiteName,
} from './tools/search_tool.js';

export {
  fetchDomContextTool,
  verifySelectorTool,
  fetchAndCondenseDom,
  verifySelector,
  evaluateElementCandidate,
  isBotBlocked,
  isHydrationPending,
  normalizeValue,
  attachSsrfRouteGuard,
} from './tools/scrapper_tool.js';

// 7. Export prompts & builders
export {
  PLANNER_SYSTEM_PROMPT,
  SCOUT_SYSTEM_PROMPT,
  INSPECTOR_SYSTEM_PROMPT,
  SYNTHESIZER_SYSTEM_PROMPT,
  buildPlannerPrompt,
  buildScoutPrompt,
  buildScoutRankingPrompt,
  buildInspectorPrompt,
  buildSynthesizerPrompt,
} from './prompts.js';

/**
 * Creates a native Strands SDK tool wrapping the Deep Web Research Harness.
 */
export function createDeepResearchTool(config?: DeepResearchConfig) {
  const harness = new DeepResearchHarness(config);

  return tool({
    name: 'deep_web_research',
    description:
      'Autonomously discovers, inspects, and qualifies live web sources for Sentinel observation rules, synthesizing resilient CSS selectors.',
    inputSchema: z.object({
      query: z.string().describe('The monitoring target query'),
      targetDataKind: TargetDataKindEnum.describe('Classification of target metric'),
      expectedOperator: SentinelOperatorEnum.describe('Condition operator to monitor'),
      targetValue: z.union([z.string(), z.number()]).optional().describe('Threshold value if specified'),
      preferredDomains: z.array(z.string()).optional().describe('Optional list of preferred domains'),
      preferredDomainsPolicy: PreferredDomainsPolicyEnum.optional().describe('Policy: SOFT_PREFERENCE or STRICT_REQUIREMENT'),
      userConstraints: z.array(z.string()).optional().describe('Optional user exclusions and constraints (e.g. ["exclude ebay"])'),
    }),
    callback: async function* (
      input: {
        query: string;
        targetDataKind: DeepResearchTask['targetDataKind'];
        expectedOperator: DeepResearchTask['expectedOperator'];
        targetValue?: string | number;
        preferredDomains?: string[];
        preferredDomainsPolicy?: DeepResearchTask['preferredDomainsPolicy'];
        userConstraints?: string[];
      },
      context?: ToolContext
    ): AsyncGenerator<ResearchTelemetryEvent, DeepResearchOutcome, unknown> {
      const taskId = (context?.invocationState?.taskId as string) || `task-${Date.now()}`;
      const task: DeepResearchTask = {
        id: taskId,
        query: input.query,
        targetDataKind: input.targetDataKind,
        expectedOperator: input.expectedOperator,
        targetValue: input.targetValue,
        preferredDomains: input.preferredDomains,
        preferredDomainsPolicy: input.preferredDomainsPolicy,
        userConstraints: input.userConstraints,
      };

      const stream = harness.stream(task, { signal: context?.cancelSignal });
      let next = await stream.next();
      while (!next.done) {
        yield next.value;
        next = await stream.next();
      }

      return next.value;
    },
  });
}