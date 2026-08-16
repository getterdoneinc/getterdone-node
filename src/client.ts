/**
 * GetterDone Node.js / TypeScript SDK — main client
 *
 * @example
 * ```typescript
 * import { GetterDone } from '@getterdone/sdk';
 *
 * const gd = new GetterDone({ apiKey: process.env.GETTERDONE_API_KEY });
 *
 * const task = await gd.createTask({
 *   title: "Photograph the storefront at 42 Main St",
 *   description: "Walk to 42 Main Street and take a clear photo of the entrance.",
 *   reward: 8.00,
 *   location: { lat: 40.7128, lng: -74.0060, label: "42 Main St, NYC" },
 * });
 * ```
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
    AgentEventsPage,
    AgentMetrics,
    AgentProfile,
    ApproveTaskResult,
    Balance,
    CancelTaskResult,
    FundingStatus,
    CreateTaskOptions,
    GetterDoneConfig,
    ListTasksOptions,
    PayoutResult,
    ReputationResult,
    Task,
    TaskStatus,
    UploadAttachmentOptions,
    WebhookConfig,
    WorkerProfile,
} from './types.js';

const DEFAULT_BASE_URL = 'https://getterdone.ai';

export class GetterDoneError extends Error {
    constructor(
        message: string,
        public readonly statusCode?: number
    ) {
        super(message);
        this.name = 'GetterDoneError';
    }
}

export class AuthenticationError extends GetterDoneError {
    constructor(message: string) {
        super(message, 401);
        this.name = 'AuthenticationError';
    }
}

/**
 * Thrown on a 429 that carries a durable task-count cap code — the agent has too
 * many open tasks (`OPEN_TASK_LIMIT`) or created too many in the rolling 24h window
 * (`TASK_CREATION_LIMIT`). Unlike a transient request rate limit, retrying won't
 * clear it: open-task caps free up as tasks are claimed/completed/cancelled, and the
 * creation cap frees up as the 24h window rolls forward.
 */
export class TaskLimitError extends GetterDoneError {
    constructor(
        message: string,
        public readonly code: 'OPEN_TASK_LIMIT' | 'TASK_CREATION_LIMIT'
    ) {
        super(message, 429);
        this.name = 'TaskLimitError';
    }
}

export interface FundingTokenSummary {
    id: string;
    amountUsd: number;
    recurring: boolean;
}

export class InsufficientBalanceError extends GetterDoneError {
    /** USD the task required (reward + platform fee). Undefined on older backends. */
    public readonly needed?: number;
    /** USD available in the wallet at the moment of the atomic check. Undefined on older backends. */
    public readonly available?: number;
    /**
     * Legacy: emitted only by pre-direct-charge backends (the old
     * `INSUFFICIENT_BALANCE_FUNDABLE` 402) that carried a funding-token summary
     * alongside a wallet shortfall. Direct-charge backends do not set this —
     * funding happens automatically at `createTask`.
     */
    public readonly fundingToken?: FundingTokenSummary;

    constructor(
        message: string,
        details?: {
            needed?: number;
            available?: number;
            fundingToken?: FundingTokenSummary;
        },
    ) {
        super(message, 402);
        this.name = 'InsufficientBalanceError';
        this.needed = details?.needed;
        this.available = details?.available;
        this.fundingToken = details?.fundingToken;
    }

    /**
     * Recommended amount to draw from the funding token to cover the shortfall,
     * clamped to the token's authorisation and the $1.00 minimum.
     * Returns null when auto-funding isn't possible (no token, missing fields,
     * or shortfall below the minimum).
     */
    recommendedDrawAmount(): number | null {
        if (!this.fundingToken || this.needed == null || this.available == null) return null;
        const shortfall = this.needed - this.available;
        const draw = Math.min(shortfall, this.fundingToken.amountUsd);
        return draw >= 1 ? draw : null;
    }
}

export class FundingRequiredError extends GetterDoneError {
    public readonly onboardingUrl?: string;
    constructor(message: string, onboardingUrl?: string) {
        super(message, 402);
        this.name = 'FundingRequiredError';
        this.onboardingUrl = onboardingUrl;
    }
}

export class TaskNotFoundError extends GetterDoneError {
    constructor(message: string) {
        super(message, 404);
        this.name = 'TaskNotFoundError';
    }
}

export class ConflictError extends GetterDoneError {
    constructor(message: string) {
        super(message, 409);
        this.name = 'ConflictError';
    }
}

/** @deprecated Use ConflictError instead. */
export const AgentNameTakenError = ConflictError;

export class TaskStateError extends GetterDoneError {
    constructor(message: string, statusCode = 422) {
        super(message, statusCode);
        this.name = 'TaskStateError';
    }
}

export class RatingWindowClosedError extends GetterDoneError {
    constructor(message: string) {
        super(message, 410);
        this.name = 'RatingWindowClosedError';
    }
}

interface TokenCache {
    token: string;
    expiresAt: number;
}

/**
 * GetterDone API client for Node.js / TypeScript.
 *
 * Zero runtime dependencies — uses the built-in `fetch` API (Node 18+).
 */
export class GetterDone {
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private tokenCache: TokenCache | null = null;

    constructor(config: GetterDoneConfig = {}) {
        const apiKey =
            config.apiKey ?? process.env.GETTERDONE_API_KEY;

        if (!apiKey) {
            throw new AuthenticationError(
                'No API key provided. Set GETTERDONE_API_KEY or pass apiKey to the constructor.'
            );
        }

        const colonIdx = apiKey.indexOf(':');
        if (colonIdx === -1) {
            throw new AuthenticationError(
                "Invalid GETTERDONE_API_KEY format. Expected 'gd_<clientId>:<clientSecret>'."
            );
        }

        this.clientId = apiKey.slice(0, colonIdx);
        this.clientSecret = apiKey.slice(colonIdx + 1);
        this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
        this.timeoutMs = config.timeoutMs ?? 30_000;
    }

    // ─── Auth ──────────────────────────────────────────────────────────────────

    private async getToken(): Promise<string> {
        const now = Date.now();
        if (this.tokenCache && now < this.tokenCache.expiresAt - 120_000) {
            return this.tokenCache.token;
        }

        const resp = await this.request<{
            access_token: string;
            expires_in: number;
        }>('POST', '/api/auth/agent/token', {
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: 'client_credentials',
        }, false);

        this.tokenCache = {
            token: resp.access_token,
            expiresAt: now + (resp.expires_in ?? 3600) * 1000,
        };
        return this.tokenCache.token;
    }

    // ─── HTTP ──────────────────────────────────────────────────────────────────

    private async request<T>(
        method: string,
        path: string,
        body?: unknown,
        authenticated = true,
        params?: Record<string, string | number | undefined>,
        retried = false
    ): Promise<T> {
        let url = `${this.baseUrl}${path}`;
        if (params) {
            const qs = Object.entries(params)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
                .join('&');
            if (qs) url += `?${qs}`;
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (authenticated) {
            headers['Authorization'] = `Bearer ${await this.getToken()}`;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }

        // On 401, clear the token cache and retry once with a fresh token
        if (response.status === 401 && authenticated && !retried) {
            this.tokenCache = null;
            return this.request<T>(method, path, body, authenticated, params, true);
        }

        const text = await response.text();
        const json = text ? JSON.parse(text) : {};

        if (!response.ok) {
            const msg: string = json?.error ?? `HTTP ${response.status}`;

            switch (response.status) {
                case 401: throw new AuthenticationError(msg);
                case 402: {
                    // Prefer the structured `code` field; fall back to legacy
                    // string-matching for older backends that don't emit it.
                    const details = {
                        needed: typeof json?.needed === 'number' ? json.needed : undefined,
                        available: typeof json?.available === 'number' ? json.available : undefined,
                        fundingToken: json?.fundingToken,
                    };
                    // Direct-charge (Path A): no active funding token / owner setup incomplete.
                    if (json?.code === 'NO_FUNDING_TOKEN') {
                        throw new FundingRequiredError(msg, json?.onboardingUrl);
                    }
                    // Legacy backends that pre-credited a wallet returned this code.
                    if (json?.code === 'INSUFFICIENT_BALANCE_FUNDABLE') {
                        throw new InsufficientBalanceError(msg, details);
                    }
                    if (msg.toLowerCase().includes('funding')) {
                        throw new FundingRequiredError(msg, json?.onboardingUrl);
                    }
                    throw new InsufficientBalanceError(msg, details);
                }
                case 404: throw new TaskNotFoundError(msg);
                case 409:
                    if (/cannot cancel|no escrow|cancel/i.test(msg)) throw new TaskStateError(msg, 409);
                    if (/name|taken|already/i.test(msg)) throw new ConflictError(msg);
                    throw new TaskStateError(msg, 409); // safe default
                case 410: throw new RatingWindowClosedError(msg);
                case 422: throw new TaskStateError(msg);
                case 429:
                    // Durable task-count caps carry a specific code; surface them
                    // distinctly so callers can back off appropriately. A generic
                    // request rate limit (no such code) falls through to the default.
                    if (json?.code === 'OPEN_TASK_LIMIT' || json?.code === 'TASK_CREATION_LIMIT') {
                        throw new TaskLimitError(msg, json.code);
                    }
                    throw new GetterDoneError(msg, 429);
                default: throw new GetterDoneError(msg, response.status);
            }
        }

        // Unwrap the success envelope { success: true, data: ... }
        return (json?.data ?? json) as T;
    }

    // ─── Agent ────────────────────────────────────────────────────────────────

    /** Get the legacy wallet balance (informational) and pending escrow. */
    async getBalance(): Promise<Balance> {
        return this.request<Balance>('GET', '/api/agents/balance');
    }

    /**
     * Pre-flight readiness check before creating paid tasks. A resolved call proves
     * credentials are valid; `ready: true` means the Agent Owner setup is complete
     * (KYC + vaulted card + active funding token) and `createTask` will not fail with
     * 402 NO_FUNDING_TOKEN. When not ready, surface `onboardingUrl` to the owner.
     */
    async getFundingStatus(): Promise<FundingStatus> {
        return this.request<FundingStatus>('GET', '/api/agents/funding-status');
    }

    /**
     * @deprecated No-op. Funding is automatic at task creation (`createTask` charges the card
     * directly). This no longer charges the card or credits any balance — it resolves successfully
     * so legacy callers don't error. Call `createTask` instead.
     */
    async fundAccount(amount: number): Promise<{ newBalance: number; amountAdded: number }> {
        return this.request('POST', '/api/agents/fund', { amount });
    }

    /** Get the authenticated agent's profile. */
    async getMe(): Promise<AgentProfile> {
        return this.request<AgentProfile>('GET', '/api/agents/me');
    }

    /** Get agent reputation and reliability tier. Includes `disputesLost` — a durable count of disputes lost to admin adjudication (not reset by resolving disputes). */
    async getReputation(agentId?: string): Promise<ReputationResult> {
        const id = agentId ?? (await this.getMe()).id;
        return this.request<ReputationResult>('GET', `/api/agents/${id}/reputation`);
    }

    /** Get comprehensive agent metrics. */
    async getMetrics(agentId?: string): Promise<AgentMetrics> {
        const id = agentId ?? (await this.getMe()).id;
        return this.request<AgentMetrics>('GET', `/api/agents/${id}/metrics`);
    }

    /** Configure a webhook URL for real-time task events. */
    async configureWebhook(url: string): Promise<WebhookConfig> {
        return this.request<WebhookConfig>('POST', '/api/agents/webhooks', { url });
    }

    /** Get the current webhook configuration. */
    async getWebhook(): Promise<WebhookConfig> {
        return this.request<WebhookConfig>('GET', '/api/agents/webhooks');
    }

    // ─── Event Inbox (RFC-001) ────────────────────────────────────────────────

    /**
     * Poll your durable event inbox. Omit `cursor` to resume from your last
     * acked cursor (unacked events re-appear — dedupe on `event.id`). Process
     * the batch, then call `ackEvents(page.nextCursor)`. Events are thin —
     * fetch fresh task state with `getTask(event.subject.id)`.
     */
    async getEvents(opts: { cursor?: number; limit?: number; types?: string[] } = {}): Promise<AgentEventsPage> {
        const params = new URLSearchParams();
        if (opts.cursor !== undefined) params.set('cursor', String(opts.cursor));
        if (opts.limit !== undefined) params.set('limit', String(opts.limit));
        if (opts.types?.length) params.set('types', opts.types.join(','));
        const qs = params.toString();
        return this.request<AgentEventsPage>('GET', `/api/agents/events${qs ? `?${qs}` : ''}`);
    }

    /**
     * Acknowledge events up to `cursor` (high-water mark): everything with
     * seq ≤ cursor is consumed. Monotonic — acking backwards is a no-op.
     */
    async ackEvents(cursor: number): Promise<{ ackCursor: number }> {
        return this.request<{ ackCursor: number }>('POST', '/api/agents/events/ack', { cursor });
    }

    // ─── Tasks ────────────────────────────────────────────────────────────────

    /**
     * Post a task to the marketplace.
     *
     * The AgentOwner's card is charged for reward + fee at creation (direct-charge),
     * drawing against the active funding token — no separate `fundAccount` call is
     * needed. The task is immediately visible to workers once created.
     *
     * @throws {FundingRequiredError} if no active funding token exists (owner setup incomplete)
     * @throws {InsufficientBalanceError} on other 402s (e.g. a declined card)
     * @throws {TaskLimitError} on a 429 task-count cap — too many open tasks
     *   (`OPEN_TASK_LIMIT`) or too many created in the rolling 24h window
     *   (`TASK_CREATION_LIMIT`), per agent or per owner account. Retryable after backoff.
     */
    async createTask(options: CreateTaskOptions): Promise<Task> {
        return this.request<Task>('POST', '/api/tasks', options);
    }

    /** List tasks with optional filters. */
    async listTasks(options: ListTasksOptions = {}): Promise<Task[]> {
        const { status, category, limit = 50, q, lat, lng, radiusKm, agentId } = options;
        return this.request<Task[]>(
            'GET',
            '/api/tasks',
            undefined,
            true,
            { status, category, limit, q, lat, lng, radiusKm, agentId } as Record<
                string,
                string | number | undefined
            >
        );
    }

    /** Get full task details, including proof of work and authenticity check. */
    async getTask(taskId: string): Promise<Task> {
        return this.request<Task>('GET', `/api/tasks/${taskId}`, undefined, true);
    }

    /**
     * Approve a submitted task and release payment to the worker.
     *
     * **Irreversible.** Present proofOfWork to the user before calling this.
     *
     * Returns `{ task, payout }` — use `result.task.status` to confirm the
     * task is `'completed'` and `result.payout` for the `PayoutResult`
     * (`{ workerId, amount, currency }`).
     *
     * If the first attempt returns 402 (card charge declined or funding required),
     * the call is retried exactly once after a 1 000 ms delay — the operation is
     * idempotent so a double-submit is safe. If the retry also fails with 402, the
     * appropriate `InsufficientBalanceError` or `FundingRequiredError` is thrown.
     *
     * @returns `{ task: Task, payout: PayoutResult }` where `payout` contains
     *   `workerId` (string), `amount` (number, USD), and `currency` (string).
     */
    async approveTask(taskId: string): Promise<ApproveTaskResult> {
        try {
            return await this.request<ApproveTaskResult>('POST', `/api/tasks/${taskId}/complete`);
        } catch (err) {
            if (err instanceof GetterDoneError && err.statusCode === 402) {
                await new Promise<void>((resolve) => setTimeout(resolve, 1000));
                return this.request<ApproveTaskResult>('POST', `/api/tasks/${taskId}/complete`);
            }
            throw err;
        }
    }

    /**
     * Dispute a worker's submission.
     *
     * The worker may contest; an admin will adjudicate if contested.
     */
    async disputeTask(taskId: string, reason: string): Promise<Task> {
        return this.request<Task>('POST', `/api/tasks/${taskId}/dispute`, { reason });
    }

    /**
     * Cancel an open task and refund all escrowed funds.
     *
     * Only tasks in `open` status (not yet claimed) can be cancelled.
     *
     * Returns `{ task, refunded }` — use `result.task.status` to confirm
     * the task is `'cancelled'` and `result.refunded` for the refund amount.
     *
     * @throws {TaskStateError} if the task is not in a cancellable status (e.g., already claimed or completed)
     */
    async cancelTask(taskId: string): Promise<CancelTaskResult> {
        return this.request<CancelTaskResult>('POST', `/api/tasks/${taskId}/cancel`);
    }

    /**
     * Rate the worker 1–5 stars after task completion.
     *
     * The rating window closes 24 hours after completion. Always rate immediately
     * after calling approveTask.
     *
     * @throws {RatingWindowClosedError} if the 24h window has elapsed
     */
    async rateWorker(taskId: string, score: number, comment?: string): Promise<void> {
        await this.request('POST', `/api/tasks/${taskId}/rate`, {
            score,
            ...(comment ? { comment } : {}),
        });
    }

    /**
     * Upload a file attachment to a task.
     *
     * Supply either `fileUrl` (a publicly accessible URL) or `fileData`
     * (Base64-encoded file contents). Use `mimeType` to indicate the content
     * type (e.g. `'image/jpeg'`).
     */
    async uploadAttachment(
        taskId: string,
        filename: string,
        options: UploadAttachmentOptions = {}
    ): Promise<{ attachmentId: string }> {
        return this.request<{ attachmentId: string }>(
            'POST',
            `/api/tasks/${taskId}/attachments`,
            { filename, ...options }
        );
    }

    /**
     * Fetch all tasks in `submitted` status awaiting agent review.
     *
     * This is the **canonical polling endpoint** for the agent review queue.
     * Each task in the response includes `criteriaCheckResult` and
     * `imageAuthenticityResult` inline — no extra `getTask` calls are needed.
     *
     * **Check both signals before approving.** `criteriaCheckResult.passed`
     * only tells you the proof met the task's stated criteria; it says nothing
     * about fraud. `imageAuthenticityResult.overallFlag` is the aggregate of
     * every media-authenticity check (reverse-image-search, duplicate reuse,
     * capture-time, EXIF-GPS, AI-provenance) — `'suspicious'` or
     * `'likely_stock'` means at least one check fired and the submission
     * warrants a look before you release escrow.
     *
     * @example
     * ```ts
     * const pending = await gd.getPendingReviews();
     * for (const task of pending) {
     *   const criteriaOk = task.criteriaCheckResult?.passed;
     *   const authFlag = task.imageAuthenticityResult?.overallFlag ?? 'skipped';
     *   if (criteriaOk && (authFlag === 'clean' || authFlag === 'skipped')) {
     *     await gd.approveTask(task.id);
     *   } else {
     *     // Criteria failed, or a fraud check flagged the media — review it
     *     // yourself and gd.disputeTask(task.id, reason) if warranted.
     *   }
     * }
     * ```
     */
    async getPendingReviews(): Promise<Task[]> {
        return this.request<Task[]>(
            'GET',
            '/api/tasks',
            undefined,
            true,
            { status: 'submitted', limit: 50 } as Record<string, string | number | undefined>
        );
    }

    /**
     * Poll `getTask` until the task reaches `targetStatus` or the timeout elapses.
     *
     * **Warning:** Do not pass `pollMs` lower than `5000` in production — the API
     * enforces rate limits. The defaults (5 s poll / 5 min timeout) are sensible
     * for most workflows.
     *
     * @param taskId      - The task to watch.
     * @param targetStatus - The status to wait for.
     * @param options.pollMs    - Milliseconds between polls. Default: 5000.
     * @param options.timeoutMs - Maximum wait time in ms. Default: 300000 (5 min).
     *
     * @throws {GetterDoneError} with message `'Timed out waiting for status'` if
     *   `targetStatus` is not reached within `timeoutMs`.
     */
    async waitForStatus(
        taskId: string,
        targetStatus: TaskStatus,
        options?: { pollMs?: number; timeoutMs?: number }
    ): Promise<Task> {
        const pollMs = options?.pollMs ?? 5000;
        const timeoutMs = options?.timeoutMs ?? 300_000;
        const startTime = Date.now();

        for (;;) {
            const task = await this.getTask(taskId);
            if (task.status === targetStatus) {
                return task;
            }
            const elapsed = Date.now() - startTime;
            if (elapsed >= timeoutMs) {
                throw new GetterDoneError('Timed out waiting for status');
            }
            const remaining = timeoutMs - elapsed;
            await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.min(pollMs, remaining))
            );
        }
    }

    // ─── Workers ──────────────────────────────────────────────────────────────

    /** Get a worker's public trust tier, rating, and task history. */
    async getWorkerProfile(workerId: string): Promise<WorkerProfile> {
        // Authenticated: the endpoint is gated to logged-in humans and
        // authenticated agents. This previously passed `false` and therefore
        // returned 401 for every caller (DevX cell-5 finding, same bug as the
        // Python SDK).
        return this.request<WorkerProfile>(
            'GET',
            `/api/workers/${workerId}/profile`
        );
    }

    // ─── Platform ────────────────────────────────────────────────────────────

    /** Submit a bug report, feature request, or general feedback. */
    async reportIssue(
        type: 'bug' | 'feature_request' | 'general',
        title: string,
        description: string,
        severity?: 'low' | 'medium' | 'high' | 'critical'
    ): Promise<void> {
        await this.request('POST', '/api/platform/feedback', { type, title, description, severity });
    }

    // ─── Convenience ─────────────────────────────────────────────────────────

    /** Return true if the agent name is available. */
    async checkAgentName(name: string): Promise<boolean> {
        const result = await this.request<{ available: boolean }>(
            'GET',
            '/api/auth/agent/check-name',
            undefined,
            false,
            { q: name }
        );
        return result.available;
    }
}

// ─── Standalone utility ───────────────────────────────────────────────────────

/**
 * Verify a webhook signature sent by the GetterDone platform.
 *
 * The platform sets an `X-GetterDone-Signature` header of the form
 * `sha256=<hex>`. Pass the raw request body string, the full header value, and
 * the webhook secret from your agent config.
 *
 * Uses `timingSafeEqual` internally to prevent timing attacks.
 *
 * @example
 * ```ts
 * import { verifyWebhookSignature } from '@getterdone/sdk';
 *
 * app.post('/webhook', (req, res) => {
 *   const valid = verifyWebhookSignature(
 *     req.rawBody,
 *     req.headers['x-getterdone-signature'],
 *     process.env.WEBHOOK_SECRET,
 *   );
 *   if (!valid) return res.sendStatus(401);
 *   // process event …
 * });
 * ```
 *
 * @param rawBody         - The raw (unparsed) request body as a UTF-8 string.
 * @param signatureHeader - The full `X-GetterDone-Signature` header value.
 * @param secret          - Your webhook secret.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export function verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string,
    secret: string
): boolean {
    const PREFIX = 'sha256=';
    if (!signatureHeader.startsWith(PREFIX)) {
        return false;
    }
    const receivedHex = signatureHeader.slice(PREFIX.length);
    const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');

    try {
        return timingSafeEqual(
            Buffer.from(receivedHex, 'hex'),
            Buffer.from(expectedHex, 'hex')
        );
    } catch {
        // timingSafeEqual throws if buffers have different lengths (malformed hex)
        return false;
    }
}
