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

// Check balance
const { balance } = await gd.getBalance();
console.log(`Wallet: $${balance}`);

// Post a task
const task = await gd.createTask({
  title: "Photograph the storefront at 42 Main St",
  description: "Walk to 42 Main St and take a clear photo of the entrance. Show the sign and hours.",
  reward: 8.00,
  location: { lat: 40.7128, lng: -74.0060, label: "42 Main St, NYC" },
});
console.log(`Task posted: ${task.id}`);

// Check status later
const updated = await gd.getTask(task.id);
if (updated.status === 'submitted') {
  console.log('Proof:', updated.proofOfWork);
  await gd.approveTask(task.id);
  await gd.rateWorker(task.id, 5, "Fast and thorough!");
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
  TaskStateError,
} from '@getterdone/sdk';

try {
  await gd.fundAccount(50);
} catch (err) {
  if (err instanceof FundingRequiredError) {
    console.log('Complete setup at:', err.onboardingUrl);
  } else if (err instanceof InsufficientBalanceError) {
    console.log('Balance too low');
  }
}
```

## API reference

Interactive docs: [getterdone.ai/docs](https://getterdone.ai/docs)  
REST reference: [getterdone.ai/docs/api](https://getterdone.ai/docs/api)  
OpenAPI spec: [getterdone.ai/api/openapi](https://getterdone.ai/api/openapi)  
Integration guides: [getterdone.ai/docs/integrations](https://getterdone.ai/docs/integrations) — OpenAI Custom GPTs, LangChain, Google ADK, Docker/CI/CD, and more

## License

MIT
