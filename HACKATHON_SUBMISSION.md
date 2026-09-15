# Sentinel

## Autonomous Background Monitoring and Decision Agent

> **Elevator pitch:** Sentinel turns plain-English goals into always-on AI watchtowers that monitor markets, websites, feeds, and channels, reason across signals, and alert users only when something matters.

---

## Inspiration

Most AI agents today fall into one of two traps:

1. **Passive chatbots:** They wait for users to ask questions. If someone wants to know whether an asset crossed a moving average, a prediction market shifted, or important regulatory news appeared, they must remember to open an app and ask repeatedly.
2. **Expensive polling loops:** Agents that send every API response or webpage snapshot to a large language model are slow, costly, and vulnerable to rate limits.

I built **Sentinel** to bridge that gap. Sentinel is a proactive, event-driven background companion. A user describes what matters in natural language, and Sentinel scouts the relevant data sources, verifies them, and converts the request into a structured monitoring rule.

The intelligence layer can then step back while lightweight sentries keep watch. When a meaningful condition is detected, Sentinel evaluates the surrounding context and delivers a timely alert or decision request to the user's device.

---

## What It Does

Sentinel transforms natural-language intent into an autonomous monitoring workflow across financial markets, prediction platforms, news feeds, public channels, and websites.

- **Conversational rule creation:** Users can describe complex goals such as: *“Alert me with a cash-register sound if NVDA drops below its 20-day VWAP while the Polymarket probability of a rate cut crosses 65%.”*
- **Automated reconnaissance:** Specialized tools identify canonical stock symbols, crypto assets, prediction-market contracts, RSS feeds, public Telegram channels, and relevant webpage signals.
- **Pre-flight verification:** Before activating a rule, Sentinel probes the selected sources, establishes baseline readings, and presents the interpreted conditions for confirmation.
- **Two-tier execution:** Deterministic sentries perform continuous, low-cost checks. Strands-powered reasoning is reserved for setup, ambiguity resolution, and judgment-heavy events.
- **Complex event processing:** Sentinel evaluates composite condition trees such as `(A AND B) OR C`, handles signals arriving at different times, and deduplicates repeated events.
- **Actionable mobile alerts:** The Expo mobile client receives live updates through WebSockets and combines concise explanations with audio and haptic alert signatures.

---

## How It Works

### 1. Intent Compilation

The **Strands Agents SDK** and **Amazon Bedrock** interpret the user's request, resolve ambiguous entities, select the appropriate tools, and compile the goal into a structured Boolean condition tree.

### 2. Deterministic Monitoring

Lightweight TypeScript evaluators monitor the selected sources and compute indicators without invoking an LLM on every polling interval.

### 3. Event-Driven Reasoning

When a candidate condition is detected—or when the source requires semantic judgment—Sentinel evaluates the evidence, explains why the condition was or was not satisfied, and determines whether an alert or user decision is warranted.

### 4. Real-Time Delivery

The backend records the evaluation, prevents duplicate events, and delivers alerts to connected clients through WebSockets and mobile notification infrastructure.

---

## Mathematical and Economic Model

### Cost of Continuous LLM Polling

In a traditional agent loop, inference cost grows with every polling interval:

$$
C_{\text{traditional}} = \sum_{t=1}^{N}
\left(
T_{\text{input}}^{(t)} P_{\text{input}} +
T_{\text{output}}^{(t)} P_{\text{output}}
\right)
$$

Sentinel separates monitoring from reasoning:

$$
C_{\text{Sentinel}} = C_{\text{setup}} + M \cdot C_{\text{reasoning}},
\qquad M \ll N
$$

Here, \\(N\\) is the number of monitoring cycles, while \\(M\\) is the much smaller number of events that genuinely require model reasoning. Deterministic polling therefore adds no LLM-token cost.

### Composite Event Resolution

For a group of conditions \\(k \in \mathcal{K}\\), Sentinel evaluates both the condition result and whether each signal falls inside its permitted time window:

$$
\Phi(\mathbf{S}_t) =
\bigvee_j
\left(
\bigwedge_{k \in \mathcal{K}_j}
\mathbf{1}_{\{\Delta t_k \leq \tau_k\}}
\cdot
\mathcal{O}_k(x_k(t), \theta_k)
\right)
$$

Where:

- \\(\mathcal{O}_k\\) is an operator such as `CROSSES_BELOW` or `GREATER_THAN`.
- \\(x_k(t)\\) is the latest observed value.
- \\(\theta_k\\) is the configured threshold.
- \\(\tau_k\\) is the maximum allowed age of the signal.

---

## How I Built It

Sentinel is a full-stack TypeScript monorepo with shared runtime schemas across the backend and mobile client.

### Agent and Orchestration Layer

- **Strands Agents SDK:** Manages conversational state, structured generation, tool selection, concurrent tool execution, and specialized evaluation workflows.
- **Amazon Bedrock and Bedrock Mantle:** Provide model inference for intent parsing, reconnaissance, ambiguity resolution, and semantic evaluation.
- **Specialized reconnaissance tools:** Cover equities, crypto markets, prediction markets, RSS/Atom feeds, public Telegram channels, deep web search, webpage extraction, technical indicators, and pre-flight verification.
- **Zod contracts:** Validate tool inputs, agent outputs, rule structures, WebSocket messages, and shared application data.

### Backend and Event Pipeline

- **Fastify:** Hosts the authenticated API, rule-management endpoints, health checks, and engine-control routes.
- **WebSockets:** Provide low-latency, bidirectional communication between the agent workflow and connected clients.
- **SQLite and DynamoDB:** Support local development and durable production storage for users, conversations, rules, evaluations, alerts, and event hashes.
- **Amazon EventBridge Scheduler and Amazon SQS:** Provide durable production scheduling, queue-based evaluation, retries, and worker isolation.
- **Amazon S3:** Supports durable agent-session storage in production.

### Mobile Client

- **Expo SDK 57, React Native 0.86, and React 19:** Power the cross-platform mobile and web experience.
- **NativeWind:** Provides a consistent responsive design system.
- **Clerk:** Handles authentication and session management.
- **Expo Notifications, Audio, and Haptics:** Deliver distinct alert experiences based on event type and urgency.

---

## Challenges I Ran Into

### LLM Polling Cost and Throttling

The earliest design repeatedly sent source snapshots to a model. That approach was expensive, slow, and prone to throttling. I replaced it with a two-tier architecture in which deterministic evaluators handle routine monitoring and models are invoked only when reasoning adds value.

### Asynchronous Signal Timing

Composite rules can depend on signals that update at very different cadences—for example, a stock-price tick and a prediction-market probability change. I built a stateful condition engine with time windows and three-valued logic so stale or temporarily unavailable data does not become a false positive.

### Fragile Web and Feed Sources

Websites, RSS feeds, and public channels vary widely in structure and reliability. Sentinel uses reconnaissance, safe fetching, schema validation, pre-flight probes, and progressively refined evaluation passes to isolate the requested signal before a rule is armed.

### Reliable Background Execution

Long-running evaluations require protection against duplicate delivery, worker crashes, and overlapping schedules. The production execution path uses EventBridge Scheduler, SQS workers, visibility-timeout extension, idempotency controls, and event hashing.

---

## Accomplishments I Am Proud Of

- **A practical two-tier agent architecture:** Sentinel separates continuous observation from expensive reasoning instead of treating an LLM as a polling engine.
- **Natural language to executable monitoring:** A conversational request becomes a validated, inspectable condition tree rather than an opaque prompt running forever.
- **Cross-domain intelligence:** One system can combine stock, crypto, prediction-market, RSS, Telegram, and web signals in a single rule.
- **Human-centered interruptions:** Sentinel delivers evidence and context only when a condition matters, with support for explicit confirmation before sensitive actions.
- **Production-aware infrastructure:** The system includes durable scheduling, queue-based workers, persistent storage, authentication, session handling, deduplication, and real-time client updates.

---

## What I Learned

- How to design cost-conscious AI systems by separating deterministic computation from model reasoning.
- How to use the Strands Agents SDK for stateful conversations, concurrent tool execution, and structured outputs.
- How to combine heterogeneous data sources into a unified, validated condition model.
- How to evaluate asynchronous signals without treating missing or stale data as a definitive result.
- How to build a real-time React Native client around WebSockets, push notifications, audio, and haptic feedback.

---

## What's Next for Sentinel

- **Safer action execution:** Add policy-controlled workflows for actions such as reservations, approvals, portfolio hedges, and smart-account transactions.
- **Bidirectional voice:** Use Strands `BidiAgent` capabilities for hands-free rule creation on mobile and wearable devices.
- **Community Sentinel Hub:** Let users publish, share, and subscribe to verified monitoring templates for major events, token launches, earnings seasons, and everyday tasks.
- **Expanded data connectors:** Add email, calendars, commerce availability, travel pricing, and additional public-data sources.
- **Production alert hardening:** Expand delivery guarantees, user preferences, quiet hours, escalation policies, and Android/iOS release support.

---

## Why Sentinel Matters

The future of useful AI is not another chat window that demands attention. It is software that understands what matters, watches quietly, and surfaces only when human judgment or action is genuinely needed.

**Sentinel turns AI from something users repeatedly consult into something that reliably keeps watch for them.**
