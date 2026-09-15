# Sentinel Hackathon Submission — Form Answers

## Testing Instructions for the Application

### Recommended reviewer flow

1. Clone the public repository and follow the **Local Demo Setup** in the root `README.md`.
2. Install Node.js 22+ and run:

   ```bash
   npm install
   npm install --prefix server
   npm install --prefix mobile
   ```

3. Copy `server/.env.example` to `server/.env`. Add valid Clerk credentials and credentials for the selected model provider. Keep the local demo settings:

   ```dotenv
   SENTINEL_INFRASTRUCTURE_MODE=local
   DATABASE_PROVIDER=sqlite
   DATABASE_PATH=./data/sentinel.db
   RUN_EMBEDDED_EVALUATOR=true
   SENTINEL_MODEL_PROVIDER=bedrock
   AWS_REGION=us-east-1
   ```

4. Copy `mobile/.env.example` to `mobile/.env`. Add the Clerk publishable key and configure the API endpoints:

   ```dotenv
   EXPO_PUBLIC_API_URL=http://localhost:8080
   EXPO_PUBLIC_WS_URL=ws://localhost:8080
   ```

   For an Android emulator, replace `localhost` with `10.0.2.2`. For a physical device, use the development computer's LAN IP address.

5. Start the backend from the repository root:

   ```bash
   npm run demo:server
   ```

6. In a second terminal, start the Expo client:

   ```bash
   npm --prefix mobile run start
   ```

7. Sign up using an email address you can verify. Create this fast-triggering demonstration rule:

   > Monitor Bitcoin and alert me with a chime when its price is above $1.

8. Confirm the interpreted request, wait for live reconnaissance and pre-flight verification, then approve the deployment card.
9. Open the dashboard to inspect the active rule, sub-sentinel state, telemetry, and alert history. The deliberately low threshold should trigger an audio alert quickly. Pause and resume the watcher to verify lifecycle controls.

### Expected result

Sentinel should convert the natural-language request into a validated watcher, obtain explicit approval before activation, evaluate live data in the background, and deliver the resulting telemetry and alert through the realtime client. Keep the backend running during the test because local mode uses its embedded evaluator.

## Architecture Diagram

Upload:

- `submission/sentinel-architecture.png` — 2400 × 1600 PNG, 1.30 MB

The diagram distinguishes the two execution tiers and the two infrastructure modes:

- **Agentic setup:** Strands Agents SDK and Amazon Bedrock interpret the request, research sources, verify a baseline, synthesize a typed condition tree, and present a human approval gate.
- **Deterministic runtime:** Approved sub-sentinels are scheduled and evaluated without routine LLM polling. Triggered rules are committed idempotently and delivered as realtime alerts or human-approved actions.
- **Local demo mode:** SQLite plus the embedded scheduler/evaluator.
- **AWS scale-out mode:** DynamoDB/S3 persistence plus EventBridge Scheduler, SQS, and bounded workers.

## Public Code Repository

```text
https://github.com/Avijeet-Blocsol/Sentinel
```

The repository is anonymously reachable. Before submitting, complete the organizer's repository requirements:

- Add either an **MIT** or **Apache-2.0** `LICENSE` file.
- Add the selected license name and link to the root `README.md`.
- Set the GitHub repository **About** description and website/demo URL.
- Confirm that no `.env` files, cloud credentials, signing keys, or test secrets appear in the repository or its history.

## Suggested GitHub About Description

> An always-on AI watchtower built with Strands and Amazon Bedrock. Sentinel turns plain-English goals into verified, deterministic monitors and alerts users only when action matters.

