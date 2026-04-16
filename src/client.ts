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

import type {
    AgentProfile,
    Balance,
    CreateTaskOptions,
    GetterDoneConfig,
    ListTasksOptions,
    ReputationResult,
    Task,
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

export class InsufficientBalanceError extends GetterDoneError {
    constructor(message: string) {
        super(message, 402);
        this.name = 'InsufficientBalanceError';
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

export class AgentNameTakenError extends GetterDoneError {
    constructor(message: string) {
        super(message, 409);
        this.name = 'AgentNameTakenError';
    }
}

export class TaskStateError extends GetterDoneError {
    constructor(message: string) {
        super(message, 422);
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
        if (this.tokenCache && now < this.tokenCache.expiresAt - 60_000) {
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
        params?: Record<string, string | number | undefined>
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

        const text = await response.text();
        const json = text ? JSON.parse(text) : {};

        if (!response.ok) {
            const msg: string = json?.error ?? `HTTP ${response.status}`;

            switch (response.status) {
                case 401: throw new AuthenticationError(msg);
                case 402:
                    if (msg.toLowerCase().includes('funding')) {
                        throw new FundingRequiredError(msg, json?.onboardingUrl);
                    }
                    throw new InsufficientBalanceError(msg);
                case 404: throw new TaskNotFoundError(msg);
                case 409: throw new AgentNameTakenError(msg);
                case 410: throw new RatingWindowClosedError(msg);
                case 422: throw new TaskStateError(msg);
                default: throw new GetterDoneError(msg, response.status);
            }
        }

        // Unwrap the success envelope { success: true, data: ... }
        return (json?.data ?? json) as T;
    }

    // ─── Agent ────────────────────────────────────────────────────────────────

    /** Get current wallet balance and pending escrow. */
    async getBalance(): Promise<Balance> {
        return this.request<Balance>('GET', '/api/agents/balance');
    }

    /**
     * Add USD to the agent wallet.
     * @throws {FundingRequiredError} if agent owner setup is incomplete
     */
    async fundAccount(amount: number): Promise<{ newBalance: number; amountAdded: number }> {
        return this.request('POST', '/api/agents/fund', { amount });
    }

    /** Get the authenticated agent's profile. */
    async getMe(): Promise<AgentProfile> {
        return this.request<AgentProfile>('GET', '/api/agents/me');
    }

    /** Get agent reputation and reliability tier. */
    async getReputation(agentId?: string): Promise<ReputationResult> {
        const id = agentId ?? (await this.getMe()).id;
        return this.request<ReputationResult>('GET', `/api/agents/${id}/reputation`);
    }

    /** Get comprehensive agent metrics. */
    async getMetrics(agentId?: string): Promise<unknown> {
        const id = agentId ?? (await this.getMe()).id;
        return this.request('GET', `/api/agents/${id}/metrics`);
    }

    /** Configure a webhook URL for real-time task events. */
    async configureWebhook(url: string): Promise<WebhookConfig> {
        return this.request<WebhookConfig>('POST', '/api/agents/webhooks', { url });
    }

    /** Get the current webhook configuration. */
    async getWebhook(): Promise<WebhookConfig> {
        return this.request<WebhookConfig>('GET', '/api/agents/webhooks');
    }

    // ─── Tasks ────────────────────────────────────────────────────────────────

    /**
     * Post a task to the marketplace.
     *
     * Escrow is atomically deducted from your wallet. The task is immediately
     * visible to workers once created.
     *
     * @throws {InsufficientBalanceError} if wallet balance is too low
     */
    async createTask(options: CreateTaskOptions): Promise<Task> {
        return this.request<Task>('POST', '/api/tasks', options);
    }

    /** List tasks with optional filters. */
    async listTasks(options: ListTasksOptions = {}): Promise<Task[]> {
        const { status, category, limit = 50, q, lat, lng, radiusKm } = options;
        return this.request<Task[]>(
            'GET',
            '/api/tasks',
            undefined,
            false,
            { status, category, limit, q, lat, lng, radiusKm } as Record<
                string,
                string | number | undefined
            >
        );
    }

    /** Get full task details, including proof of work and authenticity check. */
    async getTask(taskId: string): Promise<Task> {
        return this.request<Task>('GET', `/api/tasks/${taskId}`, undefined, false);
    }

    /**
     * Approve a submitted task and release payment to the worker.
     *
     * **Irreversible.** Present proofOfWork to the user before calling this.
     */
    async approveTask(taskId: string): Promise<{ task: Task; payout: unknown }> {
        return this.request('POST', `/api/tasks/${taskId}/complete`);
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
     * Only tasks in `open` status (not yet claimed) can be canceled.
     */
    async cancelTask(taskId: string): Promise<Task> {
        return this.request<Task>('POST', `/api/tasks/${taskId}/cancel`);
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

    // ─── Workers ──────────────────────────────────────────────────────────────

    /** Get a worker's public trust tier, rating, and task history. */
    async getWorkerProfile(workerId: string): Promise<WorkerProfile> {
        return this.request<WorkerProfile>(
            'GET',
            `/api/workers/${workerId}/profile`,
            undefined,
            false
        );
    }

    // ─── Platform ────────────────────────────────────────────────────────────

    /** Submit a bug report or feature request. */
    async reportIssue(
        message: string,
        type: 'bug' | 'feature' | 'other' = 'other'
    ): Promise<void> {
        await this.request('POST', '/api/platform/feedback', { type, message });
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
