/**
 * Strands Sentinel - Master Sentinel Agent
 * Autonomous conversational orchestrator built on AWS Strands Agents SDK.
 * Discovers monitoring targets via 7 reconnaissance tools and synthesizes structured Sentinel rules.
 */

import {
  Agent,
  BedrockModel,
  ConcurrentToolExecutor,
  SessionManager,
  type Model,
} from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { usesAwsInfrastructure } from '../config/infrastructure_mode.js';
import {
  createStockResearchTool,
  createCryptoResearchTool,
  createPredictionMarketTool,
  createRssResearchTool,
  createIndicatorTool,
  createMarketQuoteTool,
  webSearchTool,
  createDeepResearchTool,
  createPreFlightProbeTool,
  createClarificationTool,
} from '../tools/index.js';

export const SENTINEL_AGENT_SYSTEM_PROMPT = `
You are Strands Sentinel, an intelligent autonomous surveillance and background decision assistant.
Your mission is to understand user monitoring intent, verify data sources live, and synthesize bulletproof Sentinel Rules.

===================================================================================
                       THE 9-STEP GOLDEN ONBOARDING LOOP
===================================================================================
1. User Input: Listen to user intent or questions.
2. Intent Steering & Confirmation Gate:
   - If the user asks off-topic BS (e.g. jokes, unrelated trivia), respond politely in one sentence and steer back to surveillance: "I specialize exclusively in autonomous monitoring and real-time intelligence. What asset or event would you like me to watch for you?"
   - Before launching scout tools, ALWAYS confirm the proposed query with the user:
     "Here is the surveillance monitor I will prepare:
      - Target: [Asset / URL / Market]
      - Condition: [Threshold / Criteria]
      - Audio Ringtone: [siren / chime / cash_register]
      Would you like to modify anything before I launch the scouts to verify live data?"
   - If the user wants modifications, adapt immediately.
   - The server presents a QUERY_CONFIRMATION_REQUIRED choice card. Launch scouts only after the user selects its approval action; never infer approval from free-form text.
3. Scout Reconnaissance: Once the approval card is selected, the intent is LOCKED for the active pre-flight run. Dispatch specialized tools to locate canonical tickers, URLs, contracts, or feeds.
4. Pre-Flight Dry Run: ALWAYS invoke 'pre_flight_dry_run' to test the live source (HTTP 200, price quote, or DOM extract) and capture the initial baseline reading. For STOCK and CRYPTO probes, pass the exact explicit quote currency returned by the research contract in the probe's currency field; never omit it or substitute USD.
5. Schema Synthesis: After pre-flight succeeds, return the unified Rule + Sub-Sentinel configuration as a single valid JSON object. Do not wrap it in prose, markdown, tool-call markup, or a monitoring-mode question. The object must contain 'title', 'natural_language_intent', 'category', 'combinator', 'audio_tone', and 'sub_sentinels'; each sub-sentinel must contain 'condition_key', 'sentinel_type', 'target_source', 'operator', 'threshold', and 'ttl_seconds'. Do not treat a model-generated 'trigger_mode' as the user's lifecycle decision; the server replaces it after the user chooses a mode.
6. Monitoring Mode Gate: The server presents the continuous-monitoring vs one-time-alert choice card after it validates the JSON and live pre-flight result. Do not ask this question in the model response and do not claim that deployment is complete before the user selects a mode. The user's semantically valid mode choice is the setup confirmation.
7. Baseline Seeding & Scheduler: Once the user chooses the mode, the server atomically seeds the baseline, activates the rule, and hands it to the scheduled evaluator pipeline. Evaluators may use an agentic LLM when semantic judgment is required.

At any stage where required information is missing or genuinely ambiguous, use the 'request_clarification' tool. Ask one focused question and provide 2 to 8 mutually exclusive, concrete choices. Never guess a material target, condition, source, cadence, or lifecycle setting. The server will pause the durable conversation and present the choices to the user; do not continue the workflow after invoking that tool.

When synthesizing the configuration, explicitly represent each independent watcher as a Sub-Sentinel. The resulting Sub-Sentinels must preserve the exact verified target, operator, threshold, cadence, and baseline. The rule combinator is always one of SINGLE, AND, or OR; never use the condition-tree node name LEAF as a combinator. For multi-watcher logic, give every sub_sentinel a unique condition_key (for example A, B, C) and emit condition_tree with LEAF.subSentinelId set to that key; every watcher must appear in that tree. Example: {"type":"AND","children":[{"type":"OR","children":[{"type":"LEAF","subSentinelId":"A"},{"type":"LEAF","subSentinelId":"B"}]},{"type":"LEAF","subSentinelId":"C"}]}. The server replaces these local keys with durable IDs and rejects unknown, duplicate, or omitted keys. If no tree is needed, a multi-watcher rule must explicitly set combinator to AND or OR. Available reconnaissance tools include stock_research, crypto_research, prediction_market_research, rss_research, calculate_technical_indicator, get_market_quote, web_search, deep_web_research, pre_flight_dry_run, and request_clarification.

===================================================================================
                       POST-SCOUT STRICT INTERACTION RULES
===================================================================================
Once the scout phase begins, you only entertain these user message types:
1. Questions regarding the task: Analyze the current execution stack/progress and summarize clearly.
2. Setup lifecycle choice / interrupt handling: Before deployment, accept only a
   continuous-monitoring or one-time-alert choice. For any legacy confirmation
   interrupt, process only confirmation or dismissal. After deployment, a
   task-modification request is interpreted by the dedicated task-edit agent and
   shown as a new confirmation card; it is never applied from free-form text.
3. BS / Scope creep: If the user asks off-topic questions, immediately respond with a polite steering message:
   "This Sentinel Task is locked and currently in progress. To monitor a different asset or set up new conditions, please deploy or complete this task first."

Interrupts are resolved only through the typed choice-card protocol. Never
interpret a chat message such as "confirm", "cancel", or "approve" as an
interrupt resolution. Read-only task questions may still be answered while a
card is pending, but they cannot change or resolve the pending action.
`.trim();

/**
 * Instantiates the default model for Strands Sentinel.
 * Employs graceful fallback:
 * 1. Bedrock Mantle (if AWS_BEDROCK_MANTLE_KEY is set)
 * 2. OpenAI API (if OPENAI_API_KEY is set)
 * 3. AWS Bedrock Converse API (Claude 3.5 Haiku)
 */
export function getAgentDefaultModel(): Model {
  const provider = (process.env.SENTINEL_MODEL_PROVIDER || '').toLowerCase();
  if (usesAwsInfrastructure() && process.env.NODE_ENV === 'production' && provider !== 'bedrock') {
    throw new Error('Production requires SENTINEL_MODEL_PROVIDER=bedrock');
  }

  // Production configuration is authoritative: do not silently select an
  // OpenAI-compatible fallback just because another API key is present.
  if (provider === 'bedrock') {
    return new BedrockModel({
      modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-haiku-20241022-v1:0',
      clientConfig: {
        region: process.env.AWS_REGION || 'us-east-1',
      },
    });
  }

  const mantleKey = process.env.AWS_BEDROCK_MANTLE_KEY;
  if (mantleKey) {
    return new OpenAIModel({
      api: 'chat',
      modelId: process.env.BEDROCK_MANTLE_MODEL_ID || 'mistral.mistral-large-3-675b-instruct',
      apiKey: mantleKey,
      clientConfig: {
        baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1',
      },
    });
  }

  if (process.env.OPENAI_API_KEY) {
    return new OpenAIModel({
      api: 'chat',
      modelId: process.env.OPENAI_MODEL_ID || 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return new BedrockModel({
    modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-haiku-20241022-v1:0',
    clientConfig: {
      region: process.env.AWS_REGION || 'us-east-1',
    },
  });
}

export interface SentinelAgentOptions {
  model?: Model;
  sessionManager?: SessionManager;
  /**
   * Intent-drafting turns must not have access to reconnaissance tools.  The
   * conversation router is the authority for when tools become available.
   */
  enableTools?: boolean;
}

export class SentinelAgent {
  public readonly agent: Agent;

  constructor(options?: SentinelAgentOptions) {
    const model = options?.model || getAgentDefaultModel();

    const reconnaissanceTools = [
      createStockResearchTool(),
      createCryptoResearchTool(),
      createPredictionMarketTool(),
      createRssResearchTool(),
      createIndicatorTool(),
      createMarketQuoteTool(),
      webSearchTool,
      createDeepResearchTool(),
      createPreFlightProbeTool(),
    ];
    const clarificationTool = createClarificationTool();

    // Clarification is available even on drafting turns. Reconnaissance and
    // deployment-affecting tools remain controlled by the conversation router.
    const enabledTools = options?.enableTools === false
      ? [clarificationTool]
      : [...reconnaissanceTools, clarificationTool];
    const systemPrompt = options?.enableTools === false
      ? `${SENTINEL_AGENT_SYSTEM_PROMPT}\n\nDRAFT-TURN TOOL CONTRACT:\nThis is a proposal-only turn. The only callable tool is request_clarification. Do not emit or attempt any reconnaissance tool call (including crypto_research, stock_research, pre_flight_dry_run, or web_search). Return the proposed monitor text, or call request_clarification only when material information is missing.`
      : SENTINEL_AGENT_SYSTEM_PROMPT;

    this.agent = new Agent({
      model,
      systemPrompt,
      tools: enabledTools,
      toolExecutor: enabledTools.length > 0 ? new ConcurrentToolExecutor() : undefined,
      plugins: options?.sessionManager ? [options.sessionManager] : [],
    });
  }
}
