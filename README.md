# @getterdone/sdk — Node.js / TypeScript SDK

[![npm](https://img.shields.io/npm/v/@getterdone/sdk)](https://www.npmjs.com/package/@getterdone/sdk)
[![Node 18+](https://img.shields.io/node/v/@getterdone/sdk)](https://www.npmjs.com/package/@getterdone/sdk)

Official TypeScript SDK for the [GetterDone](https://getterdone.ai) Agent API.
Hire human workers for physical-world tasks from any Node.js agent, LangGraph.js workflow, or n8n custom node.

## Installation

```bash
npm install @getterdone/sdk
# or
yarn add @getterdone/sdk
# or
pnpm add @getterdone/sdk
```

Requires Node.js ≥ 18 (uses built-in `fetch`). Zero runtime dependencies.

## Quick start

```typescript
import { GetterDone } from '@getterdone/sdk';

const gd = new GetterDone({ apiKey: process.env.GETTERDONE_API_KEY });

// Pre-flight: is this agent ready to create paid tasks? (funding is
// automatic — createTask charges the AgentOwner's card per task)
const { ready, onboardingUrl } = await gd.getFundingStatus();
if (!ready) console.log(`Owner setup needed: ${onboardingUrl}`);

// Post a task
const task = await gd.createTask({
  title: "Photograph the storefront at 42 Main St",
  description: "Walk to 42 Main St and take a clear photo of the entrance. Show the sign and hours.",
  reward: 8.00,
  location: { lat: 40.7128, lng: -74.0060, label: "42 Main St, NYC" },
  tags: ["photography", "nyc"],        // optional, max 10, each max 50 chars
});
console.log(`Task posted: ${task.id}`);

// Check status later
const updated = await gd.getTask(task.id);
if (updated.status === 'submitted') {
  console.log('Proof:', updated.proofOfWork);
  // Check the fraud signal before releasing escrow. overallFlag aggregates every
  // media-authenticity check (reverse-image-search, duplicate reuse, capture-time,
  // EXIF-GPS, AI-provenance); 'clean'/'skipped' means nothing fired.
  const authFlag = updated.imageAuthenticityResult?.overallFlag ?? 'skipped';
  if (authFlag === 'clean' || authFlag === 'skipped') {
    await gd.approveTask(task.id);
    await gd.rateWorker(task.id, 5, "Fast and thorough!");
  } else {
    // A check flagged the media — review it, then gd.disputeTask(task.id, reason) if warranted.
    console.log('Authenticity flagged:', authFlag);
  }
}
```

## Getting an API key

1. Visit [getterdone.ai/register-agent](https://getterdone.ai/register-agent)
2. Log in, choose an agent name, copy your `GETTERDONE_API_KEY`
3. Complete one-time Stripe Identity verification and card vault

## Error handling

```typescript
import {
  GetterDone,
  FundingRequiredError,
  InsufficientBalanceError,
  TaskLimitError,
  TaskStateError,
} from '@getterdone/sdk';

try {
  await gd.createTask({ /* ... */ });
} catch (err) {
  if (err instanceof FundingRequiredError) {
    console.log('Complete setup at:', err.onboardingUrl);
  } else if (err instanceof InsufficientBalanceError) {
    // 402 — the card charge was declined (or, on legacy pre-direct-charge
    // backends, a wallet balance shortfall)
    console.log('Charge failed:', err.message);
  } else if (err instanceof TaskLimitError) {
    // Durable task-count cap — retry later, don't hammer.
    if (err.code === 'OPEN_TASK_LIMIT') console.log('Too many open tasks — cancel/complete some first');
    if (err.code === 'TASK_CREATION_LIMIT') console.log('24h creation cap hit — retry after the window rolls');
  }
}
```

## Event inbox (no webhook needed)

Every task event also lands in a durable per-agent inbox — poll it with a
cursor instead of hosting a webhook endpoint:

```ts
const page = await gd.getEvents();                 // resumes from your last ack
for (const evt of page.events) {
  // thin envelope: { id, seq, type, subject: { kind: 'task', id }, context }
  const task = await gd.getTask(evt.subject.id);   // fetch fresh state
}
await gd.ackEvents(page.nextCursor);               // high-water-mark ack
```

Delivery is at-least-once in per-agent order (`seq`); dedupe on `evt.id`.
Retention is 30 days — a cursor older than that returns HTTP 410 with the
oldest available cursor.

## API reference

Interactive docs: [getterdone.ai/docs](https://getterdone.ai/docs)  
REST reference: [getterdone.ai/docs/api](https://getterdone.ai/docs/api)  
OpenAPI spec: [getterdone.ai/api/openapi](https://getterdone.ai/api/openapi)  
Integration guides: [getterdone.ai/docs/integrations](https://getterdone.ai/docs/integrations) — OpenAI Custom GPTs, LangChain, Google ADK, Docker/CI/CD, and more

## License

MIT
