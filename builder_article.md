# builder.aws article draft

## Title

Agents for Humans: Building Strands Sentinel with the AWS Strands Agents SDK

## Description

I built an assistant that turns a plain-language monitoring request into a verified, human-approved watcher. This is how the Strands Agents SDK, Amazon Bedrock, and a local deterministic evaluator helped me move from a chatbot to an agent that keeps working after the conversation ends—and what I plan to move onto AWS next.

## Body

A user should be able to type one sentence, approve the result, and walk away:

> Monitor Bitcoin and alert me with a chime when its price crosses my target.

The useful part is not the answer the agent gives immediately. The useful part happens later—when the condition becomes true and the person has stopped watching the screen.

That idea became **Strands Sentinel**, my hackathon project built with the [AWS Strands Agents SDK for TypeScript](https://strandsagents.com/docs/user-guide/quickstart/typescript/). Sentinel converts a natural-language request into a verified monitoring rule, asks the user for approval, and then evaluates that rule in the background. It can monitor stocks, crypto assets, prediction markets, RSS feeds, web pages, search results, technical indicators, and public Telegram channels.

The project taught me an important distinction: a chatbot responds, but an agent takes responsibility for a process. Building that process safely required more than a prompt.

## The problem: chat ends too early

Most AI interfaces are pull-based. A person remembers a task, opens an application, explains the context, and waits for an answer. If the situation changes tomorrow, the person has to return and ask again.

Monitoring is the opposite. The user should describe the outcome once:

- Tell me when an asset crosses a threshold.
- Watch a page for a material change.
- Alert me when a prediction-market probability moves.
- Check a feed for a topic, but only notify me when the evidence is relevant.

The system should then observe, evaluate, and react without requiring the human to babysit it.

My first architectural instinct was to keep an LLM in that loop. Every interval would invoke a model, reload context, inspect a source, and decide whether to alert. That approach was easy to imagine and wrong for most checks. A price comparison does not need fresh inference every 30 seconds. Neither does a hash comparison or a numeric threshold.

I changed the role of the agent. Instead of making the LLM the polling loop, I made it the **compiler for human intent**.

## The two-tier design

Sentinel has two distinct tiers:

1. **Agentic setup:** understand the request, clarify ambiguity, research the target, verify the source, and synthesize a typed rule.
2. **Deterministic execution:** poll only when due, compare observed values, maintain state, and emit an alert when the condition is satisfied.

The agent is active where reasoning is valuable. Plain TypeScript takes over where repeatability is more valuable.

This division gives me three practical benefits:

- Simple monitoring checks do not require recurring model calls.
- The execution path is easier to test and reason about.
- I can still invoke an agentic evaluator for semantic conditions that cannot be reduced to a deterministic comparison.

The result is not “AI everywhere.” It is AI at the points where judgment changes the outcome.

## Why I chose the AWS Strands Agents SDK

The [Strands Agents SDK](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-frameworks/strands-agents.html) became the center of the setup tier. It gave me a clean agent loop, model-provider support, tool execution, session integration, and an idiomatic TypeScript API.

The core of my agent is deliberately small:

```typescript
this.agent = new Agent({
  model,
  systemPrompt: SENTINEL_AGENT_SYSTEM_PROMPT,
  tools: enabledTools,
  toolExecutor: enabledTools.length > 0
    ? new ConcurrentToolExecutor()
    : undefined,
  plugins: sessionManager ? [sessionManager] : [],
});
```

That small constructor sits on top of the harder product work:

- A conversation state machine controls when the agent may research or deploy.
- Native Strands tools wrap each research harness.
- `ConcurrentToolExecutor` lets independent scouts run concurrently.
- `SessionManager` preserves the context of each Sentinel conversation.
- The model layer supports [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/) as the primary AWS path while retaining provider flexibility during development.

Strands let me focus on the behavior of the agent instead of building an agent loop from scratch.

## Tools turned the agent into a researcher

A monitoring request often omits the details software needs. “Watch Bitcoin” does not specify an exchange, a canonical symbol, a price source, a comparison operator, a polling cadence, or a baseline.

I built Strands tools for:

- Stock and crypto research
- Market quotes and technical indicators
- Prediction-market inspection
- RSS discovery and evaluation
- Web search and deeper web research
- Web-page observation
- Public Telegram-channel research
- Pre-flight source verification

The last tool is the most important. Before Sentinel offers a watcher for approval, `pre_flight_dry_run` must prove that the proposed source works. Depending on the target, that means retrieving a live quote, receiving a successful HTTP response, extracting the expected page content, or recording an initial baseline.

Without pre-flight verification, the agent can produce a configuration that looks convincing but fails on its first background run. I wanted the proposal card to represent tested work, not confidence-shaped text.

## Agent output is a proposal, not authority

Letting a model emit JSON does not make that JSON trustworthy.

Sentinel validates every generated rule against shared Zod schemas. Each independent watcher becomes a **sub-sentinel** with a server-generated identifier, exact source, operator, threshold, cadence, and health state. Multi-condition requests are represented as explicit `AND`, `OR`, and `NOT` trees.

For example, the agent can propose a condition tree like this:

```json
{
  "type": "AND",
  "children": [
    { "type": "LEAF", "subSentinelId": "PRICE" },
    { "type": "LEAF", "subSentinelId": "NEWS" }
  ]
}
```

Those model-local labels are never persisted directly. The server binds them to generated IDs and rejects unknown, duplicated, or omitted references. A malformed condition tree cannot silently turn into a different watcher.

That validation boundary became one of the most important parts of the project. The agent can suggest structure; application code decides whether that structure is safe to store.

## Agents for humans means humans keep the final say

The title is not just a hackathon label. It became a design constraint.

Sentinel never activates a newly synthesized watcher immediately. It first stages a paused rule and creates a confirmation card showing the target, baseline, cadence, and alert behavior. While that decision is pending, the conversation cannot quietly mutate the approved scope.

Only an explicit human approval performs the atomic deployment transition:

```text
PROPOSED -> PAUSED -> HUMAN APPROVAL -> ACTIVE
```

Rejecting the card discards the deployment. Approving it commits the rule, its sub-sentinels, baseline events, and conversation state together. Duplicate approvals are idempotent.

The same principle applies to consequential actions. Model-suggested actions are parsed against an allowlist and remain behind an approval gate. The goal is not to remove the person from the system. The goal is to remove repetitive attention while preserving human authority.

## From conversation to realtime product

I wanted Sentinel to feel like one continuous system rather than a collection of endpoints.

The mobile client is built with React Native and Expo. Clerk provides authentication. A Fastify server exposes REST APIs for durable resources and an authenticated WebSocket channel for the live agent session.

The path looks like this:

```text
Expo mobile app
    -> Fastify REST + authenticated WebSocket
    -> Strands agent and concurrent research tools
    -> schema-validated proposal
    -> human confirmation
    -> durable rule store
    -> deterministic evaluator
    -> telemetry, audio alert, and notification
```

As Strands streams the response and tool events, the app displays progress. After deployment, the dashboard shows active and paused Sentinels, sub-sentinel health, recent telemetry, pending actions, and alerts. Conversations remain searchable, so the user can return to the reasoning that created a watcher.

## Designing the next AWS execution path

Fast iteration mattered during the hackathon, so the application currently runs locally with SQLite and an embedded evaluator. **My present setup does not use live Amazon SQS, Amazon DynamoDB, Amazon EventBridge Scheduler, or Amazon S3 resources.**

Those services are my next production step, not part of the current demo. The target architecture is:

```text
[Planned] Amazon EventBridge Scheduler
    -> Amazon SQS execution queue
    -> bounded evaluator workers
    -> Amazon DynamoDB rule and execution state
    -> Amazon S3 Strands session storage
```

In that future design, [Amazon EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html) will own durable recurring cadence. [Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html) will decouple schedule delivery from evaluation and provide retry and dead-letter behavior. [Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html) will hold distributed rule and execution state, while Amazon S3 will back Strands session storage.

Today, the project runs with this local configuration:

```dotenv
SENTINEL_INFRASTRUCTURE_MODE=local
DATABASE_PROVIDER=sqlite
RUN_EMBEDDED_EVALUATOR=true
```

Keeping `NODE_ENV` separate from infrastructure topology was a useful decision. A production-optimized build can still run as a self-contained local demo. Moving the execution plane to AWS remains clearly isolated work rather than a hidden dependency of the hackathon build.

## Reliability work that did not fit in the demo script

The visible path is simple: request, verify, approve, monitor, alert. Most of the engineering sits underneath it.

I added:

- Atomic proposal and deployment transactions
- Durable execution leases
- Stable event IDs and duplicate-delivery protection
- Atomic cooldown claims to prevent repeated alerts
- Bounded due-item queries and retry backoff
- WebSocket reconnection and conversation revalidation
- Shared schemas across the mobile app, server, and generated JSON Schema

These features are not as visually striking as an agent calling tools, but they decide whether a background agent is useful after the happy-path demo.

## What I learned

### 1. The agent should not do work that code can do better

Strands is most valuable when it resolves ambiguity, chooses tools, synthesizes structure, or evaluates meaning. A deterministic threshold belongs in deterministic code.

### 2. Tool quality matters more than tool count

A tool is valuable when its output closes uncertainty. Pre-flight verification improved the product more than adding another source connector would have.

### 3. Human approval needs a persistence boundary

A confirmation button is only cosmetic if the rule is already active. I stage paused state first and make approval the transaction that activates it.

### 4. Agent-generated structure must be treated as untrusted input

Schema validation, reference binding, ownership checks, and allowlists are part of the agent architecture—not cleanup to add later.

### 5. Local-first can still leave a clean path to AWS

The local setup made iteration fast and made the project easy to judge. Designing repository and execution interfaces around leases, idempotency, and due schedules gives me a clearer migration path when I implement the planned AWS services.

## The result

Strands Sentinel now completes the full loop:

```text
human intent
    -> agent research
    -> verified proposal
    -> human approval
    -> autonomous observation
    -> timely human attention
```

That last arrow is the product. The agent is not trying to replace the user. It is protecting the user's attention until a decision is actually needed.

The source code is available in the [Strands Sentinel GitHub repository](https://github.com/Avijeet-Blocsol/Sentinel).

I built Sentinel with the AWS Strands Agents SDK because it gave me the right abstraction for the reasoning layer while leaving me free to design strict application boundaries around it. The result is an agent that can research like an assistant, execute like a service, and stop at the moment a human should decide.
