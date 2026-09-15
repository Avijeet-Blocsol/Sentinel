import 'dotenv/config';
import {
  Agent,
  BedrockModel,
  ConcurrentToolExecutor,
  type ContentBlock,
} from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type {
  DeepResearchTask,
  ResearchPlan,
  CandidateSite,
  SourceCategory,
  SiteDossier,
  DeepResearchOutcome,
  ResearchTelemetryEvent,
  DeepResearchConfig,
  TextualGradient,
} from './types.js';
import {
  PLANNER_SYSTEM_PROMPT,
  SCOUT_SYSTEM_PROMPT,
  INSPECTOR_SYSTEM_PROMPT,
  SYNTHESIZER_SYSTEM_PROMPT,
  buildPlannerPrompt,
  buildScoutRankingPrompt,
  buildScoutRevectorPrompt,
  buildInspectorPrompt,
  buildInspectorGradientPrompt,
} from './prompts.js';
import {
  executeWebSearch,
  webSearchTool,
  type ProviderError,
} from './tools/search_tool.js';
import {
  fetchDomContextTool,
  verifySelectorTool,
  fetchAndCondenseDom,
  verifySelector,
  type BrowserLaunchTracker,
} from './tools/scrapper_tool.js';
import {
  ResearchPlanSchema,
  CandidateSitesArraySchema,
  InspectorDecisionSchema,
  ScoutRevectorSchema,
  validateModelOutput,
} from './schemas.js';
import {
  validateAndCanonicalizeUrl,
  verifyUrlOrigin,
  matchesDomainBoundary,
} from './security/url_validator.js';
import { evaluateCondition } from './condition_evaluator.js';

export type AgentRole = 'planner' | 'scout' | 'inspector' | 'synthesizer' | 'main';
export type ResearchModel = OpenAIModel | BedrockModel;

export interface ResearchGraphOptions {
  model?: ResearchModel;
  models?: Partial<Record<AgentRole, ResearchModel>>;
  config?: DeepResearchConfig;
  signal?: AbortSignal;
  executionId?: string;
}

// ==========================================================
// 1. Model & Sub-Agent Factories
// ==========================================================

export function getModelForRole(role: AgentRole): ResearchModel {
  const mantleKey = process.env.AWS_BEDROCK_MANTLE_KEY;
  if (!mantleKey) {
    return getDefaultModel();
  }

  const roleEnvMap: Record<AgentRole, string | undefined> = {
    planner:
      process.env.MODEL_PLANNER ||
      process.env.BEDROCK_MANTLE_MODEL_ID ||
      'mistral.mistral-large-3-675b-instruct',
    scout:
      process.env.MODEL_SCOUT ||
      process.env.BEDROCK_MANTLE_MODEL_ID ||
      'deepseek.v3.2',
    inspector:
      process.env.MODEL_INSPECTOR ||
      process.env.BEDROCK_MANTLE_MODEL_ID ||
      'qwen.qwen3-coder-480b-a35b-instruct',
    synthesizer:
      process.env.MODEL_SYNTHESIZER ||
      process.env.BEDROCK_MANTLE_MODEL_ID ||
      'deepseek.v3.2',
    main:
      process.env.MODEL_MAIN ||
      process.env.BEDROCK_MANTLE_MODEL_ID ||
      'mistral.mistral-large-3-675b-instruct',
  };

  const modelId = roleEnvMap[role] || 'mistral.mistral-large-3-675b-instruct';

  return new OpenAIModel({
    api: 'chat',
    modelId,
    apiKey: mantleKey,
    clientConfig: {
      baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1',
    },
  });
}

export function getDefaultModel(): ResearchModel {
  const mantleKey = process.env.AWS_BEDROCK_MANTLE_KEY;
  if (mantleKey) {
    const modelId =
      process.env.BEDROCK_MANTLE_MODEL_ID || 'mistral.mistral-large-3-675b-instruct';
    return new OpenAIModel({
      api: 'chat',
      modelId,
      apiKey: mantleKey,
      clientConfig: {
        baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1',
      },
    });
  }
  const modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0';
  const region = process.env.AWS_REGION || 'us-west-1';
  return new BedrockModel({
    modelId,
    clientConfig: { region },
  });
}

export function createPlannerAgent(model: ResearchModel, config?: DeepResearchConfig): Agent {
  return new Agent({
    id: 'planner',
    name: 'Sentinel Research Planner',
    description: 'Decomposes monitoring tasks into targeted search queries and qualification criteria',
    model,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    printer: false,
  });
}

export function createScoutAgent(model: ResearchModel, config?: DeepResearchConfig): Agent {
  return new Agent({
    id: 'scout',
    name: 'Sentinel SERP Scout',
    description: 'Ranks and qualifies candidate landing pages discovered during search queries',
    model,
    systemPrompt: SCOUT_SYSTEM_PROMPT,
    printer: false,
  });
}

/**
 * Point 5: Inspector Agent without duplicate/untracked tool instances.
 * The deterministic graph owns DOM fetching, security validation, and selector verification.
 * The Inspector LLM purely acts as a selector reasoning agent.
 */
export function createInspectorAgent(model: ResearchModel, config?: DeepResearchConfig): Agent {
  return new Agent({
    id: 'inspector',
    name: 'Sentinel DOM Inspector',
    description: 'Performs semantic DOM condensation, AI selector synthesis, and element analysis',
    model,
    systemPrompt: INSPECTOR_SYSTEM_PROMPT,
    printer: false,
  });
}

export function createSynthesizerAgent(model: ResearchModel, config?: DeepResearchConfig): Agent {
  return new Agent({
    id: 'synthesizer',
    name: 'Sentinel Outcome Synthesizer',
    description: 'Synthesizes tri-state outcome (EXACT_MATCH, MULTIPLE_OPTIONS, NOT_FOUND) from candidate dossiers',
    model,
    systemPrompt: SYNTHESIZER_SYSTEM_PROMPT,
    printer: false,
  });
}

// ==========================================================
// 2. Helpers (Type-Safe Content Parsing & JSON Extraction)
// ==========================================================

function extractContentText(content: ContentBlock[]): string {
  return content
    .map((c) => {
      if ('text' in c && typeof c.text === 'string') {
        return c.text;
      }
      return '';
    })
    .join('\n');
}

export function extractJsonFromText<T>(text: string, fallback?: T): T {
  if (!text) {
    if (fallback !== undefined) return fallback;
    throw new Error('Empty model output, cannot extract JSON');
  }

  // 1. Direct JSON parse
  try {
    return JSON.parse(text.trim());
  } catch {}

  // 2. Markdown fenced block ```json ... ```
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }

  // 3. First '{' or '[' to matching last '}' or ']'
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let startIdx = -1;
  let endIdx = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endIdx = text.lastIndexOf('}');
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = text.lastIndexOf(']');
  }

  if (startIdx !== -1 && endIdx > startIdx) {
    try {
      return JSON.parse(text.slice(startIdx, endIdx + 1));
    } catch {}
  }

  if (fallback !== undefined) return fallback;
  throw new Error(`Failed to extract JSON from text: ${text.slice(0, 160)}...`);
}

// ==========================================================
// 3. End-to-End Pipeline Execution with Telemetry Streaming
// ==========================================================

export async function* runResearchPipeline(
  task: DeepResearchTask,
  options: ResearchGraphOptions = {}
): AsyncGenerator<ResearchTelemetryEvent, DeepResearchOutcome, unknown> {
  const taskId = task.id;
  const executionId =
    options.executionId || `${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const config = options.config || {};
  const signal = options.signal;

  // Point 18 & 4: Execution budget deadline & runtime counters
  const maxTotalTimeMs = config.maxTotalTimeMs ?? 120000;
  const startTime = Date.now();
  const deadline = startTime + maxTotalTimeMs;

  let modelCallsCount = 0;
  const maxModelCalls = config.maxModelCalls ?? 15;
  const browserLaunchTracker: BrowserLaunchTracker = {
    count: 0,
    max: config.maxBrowserLaunches ?? 2,
  };

  async function invokeAgentWithBudget(
    agent: Agent,
    prompt: string,
    cancelSignal?: AbortSignal,
    perCallTimeoutMs = 15000
  ) {
    if (modelCallsCount >= maxModelCalls) {
      throw new Error(`LLM model call budget exceeded (limit: ${maxModelCalls})`);
    }
    modelCallsCount++;

    const perCallController = new AbortController();
    const timer = setTimeout(() => {
      perCallController.abort(new Error(`Agent call timed out after ${perCallTimeoutMs}ms`));
    }, perCallTimeoutMs);
    timer.unref?.();

    const combinedSignal = cancelSignal
      ? AbortSignal.any([cancelSignal, perCallController.signal])
      : perCallController.signal;

    try {
      return await agent.invoke(prompt, { cancelSignal: combinedSignal });
    } finally {
      clearTimeout(timer);
    }
  }

  function getRemainingTimeout(maxPerOp = config.siteTimeoutMs ?? 9000): number {
    const remainingBudget = deadline - Date.now();
    if (remainingBudget <= 0) return 100;
    return Math.min(maxPerOp, remainingBudget);
  }

  // 1. Telemetry: Start
  yield {
    taskId,
    executionId,
    step: 'RESEARCH_START',
    message: `Initiating Deep Web Research for: "${task.query}"...`,
    data: { query: task.query, targetDataKind: task.targetDataKind },
    timestamp: Date.now(),
  };

  let plan: ResearchPlan;
  let candidates: CandidateSite[] = [];
  const dossiers: SiteDossier[] = [];

  // ==========================================================
  // STAGE 1: PLANNER (Hard Error Throw on Failure & Zod Validated)
  // ==========================================================
  try {
    const plannerModel = options.models?.planner ?? options.model ?? getModelForRole('planner');
    const plannerAgent = createPlannerAgent(plannerModel, config);
    const plannerPrompt = buildPlannerPrompt(task);

    const plannerResponse = await invokeAgentWithBudget(plannerAgent, plannerPrompt, signal);

    const responseText = extractContentText(plannerResponse.lastMessage.content);
    const rawParsed = extractJsonFromText(responseText);

    // Point 4: Zod schema validation
    const planValidation = validateModelOutput(ResearchPlanSchema, rawParsed, 'Stage 1 Planner');
    if (!planValidation.success) {
      throw new Error(planValidation.error);
    }
    plan = planValidation.data;
  } catch (err: unknown) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[DeepResearch:Planner] Stage 1 Planner LLM failed: ${message}`);
  }

  yield {
    taskId,
    executionId,
    step: 'PLAN_GENERATED',
    message: `Formulated ${plan.searchAngles.length} search angles across ${plan.qualificationCriteria.length} qualification rules.`,
    data: { searchAnglesCount: plan.searchAngles.length },
    timestamp: Date.now(),
  };

  if (signal?.aborted) {
    throw new Error('Research cancelled by user');
  }

  // ==========================================================
  // STAGE 2: SCOUT (SERP Retrieval & Agentic Ranking)
  // ==========================================================
  const rawHits: Array<{
    url: string;
    domain: string;
    siteName: string;
    title: string;
    snippet: string;
    sourceCategory: SourceCategory;
  }> = [];

  const allProviderErrors: ProviderError[] = [];
  let totalSearchesExecuted = 0;
  let allProvidersFailedAcrossAll = true;

  try {
    const maxAngles = config.maxSearchAngles ?? 3;
    const anglesToExecute = plan.searchAngles.slice(0, maxAngles);

    for (const angle of anglesToExecute) {
      if (signal?.aborted) break;
      if (Date.now() >= deadline) break;

      yield {
        taskId,
        executionId,
        step: 'SCOUTING_SERP',
        message: `Searching: "${angle.query}" (${angle.sourceCategory})...`,
        data: { query: angle.query, category: angle.sourceCategory },
        timestamp: Date.now(),
      };

      totalSearchesExecuted++;
      // Points 14 & 15: Structured search result and user constraints forwarding
      const searchResult = await executeWebSearch(angle.query, new Set(), {
        signal,
        maxResults: 6,
        timeoutMs: getRemainingTimeout(config.siteTimeoutMs ?? 9000),
        userConstraints: task.userConstraints,
      });

      if (!searchResult.allProvidersFailed) {
        allProvidersFailedAcrossAll = false;
      }
      allProviderErrors.push(...searchResult.providerErrors);

      for (const hit of searchResult.hits) {
        if (!rawHits.some((h) => h.url === hit.url)) {
          rawHits.push({
            url: hit.url,
            domain: hit.domain,
            siteName: hit.siteName,
            title: hit.title,
            snippet: hit.snippet,
            sourceCategory: angle.sourceCategory,
          });
        }
      }

      // Dynamic SERP Query Re-vectoring (Search Textual Gradient)
      const hasDirectLandingHit = searchResult.hits.some(
        (h) =>
          h.url.split('/').length > 4 &&
          !/forum|reddit|community|category|discussions|blog/i.test(h.url + ' ' + h.title)
      );

      if ((searchResult.hits.length === 0 || !hasDirectLandingHit) && !signal?.aborted && Date.now() < deadline) {
        try {
          const scoutModel = options.models?.scout ?? options.model ?? getModelForRole('scout');
          const scoutAgent = createScoutAgent(scoutModel, config);
          const revectorPrompt = buildScoutRevectorPrompt(task, plan, angle, searchResult.hits);

          const revectorResponse = await invokeAgentWithBudget(scoutAgent, revectorPrompt, signal);

          const revectorText = extractContentText(revectorResponse.lastMessage.content);
          const rawRevector = extractJsonFromText(revectorText);
          const revectorValidation = validateModelOutput(ScoutRevectorSchema, rawRevector, 'Scout Revector');

          if (revectorValidation.success) {
            const revectored = revectorValidation.data;
            if (revectored.revectoredQuery && revectored.revectoredQuery.trim() !== angle.query.trim()) {
              yield {
                taskId,
                executionId,
                step: 'SERP_REVECTORING',
                message: `Re-vectoring search: "${revectored.revectoredQuery}" (Gradient: ${revectored.textualGradient})`,
                data: {
                  originalQuery: angle.query,
                  revectoredQuery: revectored.revectoredQuery,
                  textualGradient: revectored.textualGradient,
                  rationale: revectored.rationale,
                },
                timestamp: Date.now(),
              };

              totalSearchesExecuted++;
              const refinedResult = await executeWebSearch(revectored.revectoredQuery, new Set(), {
                signal,
                maxResults: 6,
                timeoutMs: getRemainingTimeout(config.siteTimeoutMs ?? 9000),
                userConstraints: task.userConstraints,
              });

              if (!refinedResult.allProvidersFailed) {
                allProvidersFailedAcrossAll = false;
              }
              allProviderErrors.push(...refinedResult.providerErrors);

              for (const hit of refinedResult.hits) {
                if (!rawHits.some((h) => h.url === hit.url)) {
                  rawHits.push({
                    url: hit.url,
                    domain: hit.domain,
                    siteName: hit.siteName,
                    title: hit.title,
                    snippet: hit.snippet,
                    sourceCategory: angle.sourceCategory,
                  });
                }
              }
            }
          }
        } catch (revectorErr: unknown) {
          if (signal?.aborted) throw revectorErr;
          const msg = revectorErr instanceof Error ? revectorErr.message : String(revectorErr);
          console.warn(`[DeepResearch:Scout] SERP re-vectoring notice: ${msg}`);
        }
      }
    }

    // Point 14: Distinguish provider failure from zero results
    if (totalSearchesExecuted > 0 && allProvidersFailedAcrossAll && rawHits.length === 0) {
      const errorMsg = `All search providers failed: ${allProviderErrors.map((e) => `${e.provider}: ${e.error}`).join('; ')}`;
      yield {
        taskId,
        executionId,
        step: 'RESEARCH_ERROR',
        message: errorMsg,
        data: { providerErrors: allProviderErrors },
        timestamp: Date.now(),
      };
      return {
        status: 'ERROR',
        taskId,
        taskDescription: task.query,
        error: errorMsg,
        stage: 'SCOUT_RETRIEVAL',
        attemptedDomains: [],
      };
    }

    // Invoke Scout Agent to evaluate, qualify, and rank candidate search hits
    if (rawHits.length > 0 && !signal?.aborted && Date.now() < deadline) {
      try {
        const scoutModel = options.models?.scout ?? options.model ?? getModelForRole('scout');
        const scoutAgent = createScoutAgent(scoutModel, config);
        const rankingPrompt = buildScoutRankingPrompt(task, plan, rawHits);

        const scoutResponse = await invokeAgentWithBudget(scoutAgent, rankingPrompt, signal);

        const scoutText = extractContentText(scoutResponse.lastMessage.content);
        const rawRanked = extractJsonFromText(scoutText);
        const scoutValidation = validateModelOutput(CandidateSitesArraySchema, rawRanked, 'Scout Candidate Ranking');

        if (scoutValidation.success) {
          // Points 1 & 4: Validate URL safety and verify origin against verified search hits
          const verifiedSearchUrls = rawHits.map((h) => h.url);
          candidates = scoutValidation.data.filter((c) => {
            // 1. Must pass URL security validation (http/https, no userinfo, safe port)
            const urlCheck = validateAndCanonicalizeUrl(c.url);
            if (!urlCheck.valid) return false;

            // 2. Must originate from verified search hits
            const originCheck = verifyUrlOrigin(c.url, verifiedSearchUrls);
            if (!originCheck.verified) return false;

            c.url = urlCheck.canonicalUrl!;
            return true;
          });
        }
      } catch (scoutErr: unknown) {
        if (signal?.aborted) throw scoutErr;
        const msg = scoutErr instanceof Error ? scoutErr.message : String(scoutErr);
        console.warn(`[DeepResearch:Scout] Scout ranking agent fallback: ${msg}`);
      }
    }

    // Heuristic fallback ranking if Scout Agent returned empty or timed out
    if (candidates.length === 0 && rawHits.length > 0) {
      candidates = rawHits.map((h) => {
        let score = 0.72;
        if (task.preferredDomains?.some((pd) => matchesDomainBoundary(h.domain, pd))) score += 0.18;
        if (h.url.split('/').length > 4) score += 0.05;
        return {
          ...h,
          snippetRelevanceScore: Math.min(score, 0.95),
        };
      });
      candidates.sort((a, b) => b.snippetRelevanceScore - a.snippetRelevanceScore);
    }

    // Point 16 & Defect 9: Preferred Domains Enforcement with strict domain boundary
    const policy = task.preferredDomainsPolicy || config.preferredDomainsPolicy || 'SOFT_PREFERENCE';
    if (task.preferredDomains && task.preferredDomains.length > 0) {
      if (policy === 'STRICT_REQUIREMENT') {
        candidates = candidates.filter((c) =>
          task.preferredDomains!.some((pd) => matchesDomainBoundary(c.domain, pd))
        );
      } else {
        // Soft preference: sort preferred domains to the top
        candidates.sort((a, b) => {
          const aPref = task.preferredDomains!.some((pd) => matchesDomainBoundary(a.domain, pd));
          const bPref = task.preferredDomains!.some((pd) => matchesDomainBoundary(b.domain, pd));
          if (aPref && !bPref) return -1;
          if (!aPref && bPref) return 1;
          return b.snippetRelevanceScore - a.snippetRelevanceScore;
        });
      }
    }
  } catch (err: unknown) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    yield {
      taskId,
      executionId,
      step: 'RESEARCH_ERROR',
      message: `Scouting encountered an error: ${message}`,
      data: { error: message },
      timestamp: Date.now(),
    };
  }

  const maxCandidateSites = config.maxCandidateSites ?? 4;
  candidates = candidates.slice(0, maxCandidateSites);

  yield {
    taskId,
    executionId,
    step: 'CANDIDATES_FOUND',
    message: `Identified ${candidates.length} candidate landing pages for DOM inspection.`,
    data: { candidateCount: candidates.length },
    timestamp: Date.now(),
  };

  if (signal?.aborted) {
    throw new Error('Research cancelled by user');
  }

  if (candidates.length === 0) {
    const outcome: DeepResearchOutcome = {
      status: 'NOT_FOUND',
      taskId,
      taskDescription: task.query,
      reason:
        task.preferredDomainsPolicy === 'STRICT_REQUIREMENT' && task.preferredDomains?.length
          ? `Zero candidates matched strict preferred domains: [${task.preferredDomains.join(', ')}]`
          : 'Zero candidate landing pages were discovered across all search providers.',
      attemptedDomains: [],
      suggestion: 'Try widening search keywords or specifying a direct vendor URL.',
    };

    yield {
      taskId,
      executionId,
      step: 'RESEARCH_COMPLETE',
      message: 'Research finished with outcome: NOT_FOUND',
      data: { outcomeStatus: outcome.status },
      timestamp: Date.now(),
    };

    return outcome;
  }

  // ==========================================================
  // STAGE 3: INSPECTOR (AI Selector Synthesis + Live Verification)
  // ==========================================================
  const inspectorModel = options.models?.inspector ?? options.model ?? getModelForRole('inspector');
  const inspectorAgent = createInspectorAgent(inspectorModel, config);

  for (const candidate of candidates) {
    if (signal?.aborted) break;
    if (Date.now() >= deadline) break;

    yield {
      taskId,
      executionId,
      step: 'INSPECTING_SITE',
      message: `Inspecting DOM structure of ${candidate.siteName} (${candidate.domain})...`,
      data: { url: candidate.url, domain: candidate.domain },
      timestamp: Date.now(),
    };

    try {
      // Pass targetDataKind, headless fallback, and timeout budget to scraper
      const domContext = await fetchAndCondenseDom(
        candidate.url,
        candidate.domain,
        candidate.siteName,
        {
          signal,
          timeoutMs: getRemainingTimeout(config.siteTimeoutMs ?? 9000),
          enableHeadlessFallback: config.enableHeadlessFallback,
          targetDataKind: task.targetDataKind,
          allowPrivateForTesting: config.allowPrivateForTesting,
          browserLaunchTracker,
        }
      );

      if (!domContext.isAccessible || domContext.candidates.length === 0) {
        dossiers.push({
          url: candidate.url,
          domain: candidate.domain,
          siteName: candidate.siteName,
          scrapingTierUsed: domContext.scrapingTierUsed,
          isAccessible: domContext.isAccessible,
          hasLiveTargetData: false,
          selector: null,
          attribute: 'text',
          rawSampleValue: null,
          normalizedValue: null,
          valueRegex: null,
          pros: [],
          cons: ['Page blocked or no target elements identified in DOM'],
          rejectionReason: domContext.rejectionReason || 'No data candidates found',
          confidenceScore: 0.0,
        });
        continue;
      }

      // Delegate selector synthesis to the Inspector LLM Agent
      let proposedSelector: string;
      let fallbackSelectors: string[] = [];
      let selectorSource: SiteDossier['selectorSource'] = 'MODEL_GENERATED';

      try {
        const inspectorPrompt = buildInspectorPrompt(
          task,
          candidate,
          domContext.condensedHtml,
          domContext.candidates
        );

        const inspectorResponse = await invokeAgentWithBudget(inspectorAgent, inspectorPrompt, signal);

        const inspectorText = extractContentText(inspectorResponse.lastMessage.content);
        const rawDecision = extractJsonFromText(inspectorText);
        const decisionValidation = validateModelOutput(InspectorDecisionSchema, rawDecision, 'Inspector Decision');

        if (!decisionValidation.success) {
          throw new Error(decisionValidation.error);
        }

        proposedSelector = decisionValidation.data.selector;
        fallbackSelectors = decisionValidation.data.fallbackSelectors || [];
        selectorSource = 'MODEL_GENERATED';
      } catch (inspectorErr: unknown) {
        if (signal?.aborted) throw inspectorErr;
        // Point 19: Distinguish model failure and tag selectorSource
        selectorSource = 'HEURISTIC_FALLBACK';
        const nonDecoyCandidates = domContext.candidates.filter(
          (c) =>
            c.contextHint !== 'was-price-strikethrough' &&
            c.contextHint !== 'financing-installment'
        );
        proposedSelector = (nonDecoyCandidates[0] || domContext.candidates[0]).suggestedSelector;
        fallbackSelectors = nonDecoyCandidates.slice(1, 3).map((c) => c.suggestedSelector);
      }

      // Verify selector live on the DOM with Gradient-Guided Refinement Loop
      let currentSelector = proposedSelector;
      let dossier = await verifySelector(
        candidate.url,
        candidate.domain,
        candidate.siteName,
        currentSelector,
        task.targetDataKind,
        {
          signal,
          timeoutMs: getRemainingTimeout(config.siteTimeoutMs ?? 9000),
          enableHeadlessFallback: config.enableHeadlessFallback,
          allowPrivateForTesting: config.allowPrivateForTesting,
          browserLaunchTracker,
        }
      );
      dossier.selectorSource = selectorSource;

      // Self-Healing Textual Gradient Refinement Loop (up to 2 gradient descent steps)
      const gradientHistory: TextualGradient[] = [];
      const maxGradientIterations = config.maxGradientIterations ?? 2;
      let iteration = 0;

      while (
        (!dossier.hasLiveTargetData || dossier.confidenceScore < 0.70) &&
        iteration < maxGradientIterations &&
        !signal?.aborted &&
        Date.now() < deadline
      ) {
        iteration++;
        const diag = dossier.diagnostics || {
          selector: currentSelector,
          matchedCount: 0,
          rawSampleValue: dossier.rawSampleValue,
          rejectionReason: dossier.rejectionReason || 'Selector verification failed',
        };

        let correction = 'Focus on selecting a unique, stable element in the buy-box.';
        if (diag.isDecoy) {
          correction =
            'The selector matched a strikethrough/was-price or installment plan. Do not select .was-price, .old-price, or installment containers. Target the active current selling price.';
        } else if (diag.isPlaceholder) {
          correction =
            'The selector matched an unhydrated loading placeholder or skeleton shimmer. Target parent wrapper elements or Schema.org microdata.';
        } else if (diag.matchedCount === 0) {
          correction = `The selector "${currentSelector}" returned 0 matches. Simplify the selector using classes present in the candidate elements list.`;
        } else if (diag.matchedCount > 1) {
          correction = `The selector "${currentSelector}" matched ${diag.matchedCount} elements. Prepend a unique parent ID, container class, or data-testid attribute to guarantee a single match.`;
        }

        const gradient: TextualGradient = {
          stepIndex: iteration,
          candidateUrl: candidate.url,
          failedSelector: currentSelector,
          diagnostics: diag,
          directionalCorrection: correction,
        };

        gradientHistory.push(gradient);

        yield {
          taskId,
          executionId,
          step: 'INSPECTOR_GRADIENT_STEP',
          message: `Self-healing selector for ${candidate.siteName} (Pass ${iteration}/${maxGradientIterations}): ${gradient.directionalCorrection}`,
          data: {
            url: candidate.url,
            failedSelector: currentSelector,
            gradient: gradient.directionalCorrection,
            stepIndex: iteration,
            selectorSource: dossier.selectorSource,
          },
          timestamp: Date.now(),
        };

        try {
          const gradientPrompt = buildInspectorGradientPrompt(
            task,
            candidate,
            domContext.condensedHtml,
            domContext.candidates,
            gradient,
            gradientHistory.slice(0, -1)
          );

          const gradientResponse = await invokeAgentWithBudget(inspectorAgent, gradientPrompt, signal);

          const gradientText = extractContentText(gradientResponse.lastMessage.content);
          const rawRefined = extractJsonFromText(gradientText);
          const refinedValidation = validateModelOutput(InspectorDecisionSchema, rawRefined, 'Gradient Refinement');

          if (refinedValidation.success && refinedValidation.data.selector !== currentSelector) {
            currentSelector = refinedValidation.data.selector;
            dossier = await verifySelector(
              candidate.url,
              candidate.domain,
              candidate.siteName,
              currentSelector,
              task.targetDataKind,
              {
                signal,
                timeoutMs: getRemainingTimeout(config.siteTimeoutMs ?? 9000),
                enableHeadlessFallback: config.enableHeadlessFallback,
                allowPrivateForTesting: config.allowPrivateForTesting,
                browserLaunchTracker,
              }
            );
            dossier.selectorSource = 'MODEL_GENERATED';
          } else if (fallbackSelectors.length > 0) {
            currentSelector = fallbackSelectors.shift()!;
            dossier = await verifySelector(
              candidate.url,
              candidate.domain,
              candidate.siteName,
              currentSelector,
              task.targetDataKind,
              {
                signal,
                timeoutMs: getRemainingTimeout(config.siteTimeoutMs ?? 9000),
                enableHeadlessFallback: config.enableHeadlessFallback,
                allowPrivateForTesting: config.allowPrivateForTesting,
                browserLaunchTracker,
              }
            );
            dossier.selectorSource = 'HEURISTIC_FALLBACK';
          } else {
            break;
          }
        } catch (gradErr: unknown) {
          if (signal?.aborted) throw gradErr;
          if (fallbackSelectors.length > 0) {
            currentSelector = fallbackSelectors.shift()!;
            dossier = await verifySelector(
              candidate.url,
              candidate.domain,
              candidate.siteName,
              currentSelector,
              task.targetDataKind,
              {
                signal,
                timeoutMs: getRemainingTimeout(config.siteTimeoutMs ?? 9000),
                enableHeadlessFallback: config.enableHeadlessFallback,
                allowPrivateForTesting: config.allowPrivateForTesting,
                browserLaunchTracker,
              }
            );
            dossier.selectorSource = 'HEURISTIC_FALLBACK';
          } else {
            break;
          }
        }
      }

      // Point 3: Evaluate user condition deterministically on the observed value
      dossier.conditionEvaluation = evaluateCondition(
        task.expectedOperator,
        dossier.normalizedValue,
        task.targetValue
      );

      yield {
        taskId,
        executionId,
        step: 'SITE_INSPECTED',
        message: dossier.hasLiveTargetData
          ? `Confirmed selector "${dossier.selector}" on ${candidate.siteName} (Sample: ${dossier.rawSampleValue}) [Condition: ${dossier.conditionEvaluation.conditionSatisfied ? 'SATISFIED' : 'UNMET'}]`
          : `Selector verification failed on ${candidate.siteName}: ${dossier.rejectionReason}`,
        data: {
          url: candidate.url,
          selector: dossier.selector ?? '',
          rawSampleValue: dossier.rawSampleValue ?? '',
          confidenceScore: dossier.confidenceScore,
          conditionSatisfied: dossier.conditionEvaluation.conditionSatisfied,
          selectorSource: dossier.selectorSource,
        },
        timestamp: Date.now(),
      };

      dossiers.push(dossier);
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      dossiers.push({
        url: candidate.url,
        domain: candidate.domain,
        siteName: candidate.siteName,
        scrapingTierUsed: 'CHEERIO_STATIC',
        isAccessible: false,
        hasLiveTargetData: false,
        selector: null,
        attribute: 'text',
        rawSampleValue: null,
        normalizedValue: null,
        valueRegex: null,
        pros: [],
        cons: [`Inspection failed: ${message}`],
        rejectionReason: message,
        confidenceScore: 0.0,
      });
    }
  }

  if (signal?.aborted) {
    throw new Error('Research cancelled by user');
  }

  // ==========================================================
  // STAGE 4: RETURN FINAL OUTCOME (EXACT_MATCH | MULTIPLE_OPTIONS | NOT_FOUND | ERROR)
  // ==========================================================
  const validDossiers = dossiers.filter(
    (d) => d.isAccessible && d.hasLiveTargetData && d.selector && d.confidenceScore >= 0.70
  );

  // Defect 1: Only sources where condition is satisfied can produce match outcomes
  const satisfiedDossiers = validDossiers.filter(
    (d) => d.conditionEvaluation?.conditionSatisfied !== false
  );

  satisfiedDossiers.sort((a, b) => b.confidenceScore - a.confidenceScore);

  let finalOutcome: DeepResearchOutcome;

  if (satisfiedDossiers.length === 1) {
    finalOutcome = {
      status: 'EXACT_MATCH',
      taskId,
      taskDescription: `${task.query} on ${satisfiedDossiers[0].siteName}`,
      source: satisfiedDossiers[0],
      confidence: satisfiedDossiers[0].confidenceScore,
      conditionEvaluation: satisfiedDossiers[0].conditionEvaluation,
    };
  } else if (satisfiedDossiers.length > 1) {
    finalOutcome = {
      status: 'MULTIPLE_OPTIONS',
      taskId,
      taskDescription: `Found ${satisfiedDossiers.length} verified sources satisfying condition for ${task.query}`,
      candidates: satisfiedDossiers,
      conditionEvaluation: satisfiedDossiers[0].conditionEvaluation,
    };
  } else if (validDossiers.length > 0) {
    // Valid data was extracted, but none satisfied the user's condition (e.g. price > threshold)
    const siteSummaries = validDossiers
      .map(
        (d) =>
          `${d.siteName} (observed ${d.conditionEvaluation?.observedValue ?? d.normalizedValue})`
      )
      .join(', ');
    finalOutcome = {
      status: 'NOT_FOUND',
      taskId,
      taskDescription: task.query,
      reason: `Discovered target data on ${validDossiers.length} site(s) (${siteSummaries}), but none satisfied condition: ${task.expectedOperator} ${task.targetValue ?? ''}.`,
      attemptedDomains: validDossiers.map((d) => d.domain),
      suggestion:
        'The target product or metric exists, but its value did not satisfy your condition threshold. Consider adjusting your expected threshold.',
    };
  } else {
    // validDossiers.length === 0
    // Defect 8: If all candidates failed inspection due to bot defense, network error, or scraper error, report ERROR instead of NOT_FOUND
    const allInspectionErrors =
      candidates.length > 0 &&
      dossiers.length > 0 &&
      dossiers.every((d) => !d.isAccessible || (d.rejectionReason && !d.hasLiveTargetData));

    if (allInspectionErrors) {
      finalOutcome = {
        status: 'ERROR',
        taskId,
        taskDescription: task.query,
        error:
          `All ${dossiers.length} candidate sites failed inspection: ` +
          dossiers.map((d) => `${d.siteName} (${d.rejectionReason || 'inaccessible'})`).join('; '),
        stage: 'SITE_INSPECTION',
        attemptedDomains: dossiers.map((d) => d.domain),
      };
    } else {
      finalOutcome = {
        status: 'NOT_FOUND',
        taskId,
        taskDescription: task.query,
        reason:
          dossiers.length > 0
            ? `All ${dossiers.length} candidate sites failed verification: ` +
              dossiers.map((d) => `${d.siteName} (${d.rejectionReason || 'data not matched'})`).join(', ')
            : 'No accessible candidate sites discovered',
        attemptedDomains: dossiers.map((d) => d.domain),
        suggestion:
          'The target websites may be enforcing Cloudflare bot-blocks or require JavaScript authentication. Consider supplying a direct URL or using an alternative store.',
      };
    }
  }

  yield {
    taskId,
    executionId,
    step: 'RESEARCH_COMPLETE',
    message: `Research pipeline complete with outcome: ${finalOutcome.status}`,
    data: { outcomeStatus: finalOutcome.status },
    timestamp: Date.now(),
  };

  return finalOutcome;
}