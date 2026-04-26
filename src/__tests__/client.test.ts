/**
 * Unit tests for the GetterDone Node.js SDK client.
 *
 * Tests use a mocked global `fetch` to avoid real HTTP calls.
 * `listTasks` and `getTask` are authenticated endpoints, so each call
 * triggers a token exchange first (fetch call [0]), then the actual request
 * (fetch call [1]).
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    GetterDone,
    AuthenticationError,
    ConflictError,
    AgentNameTakenError,
    TaskStateError,
    GetterDoneError,
    InsufficientBalanceError,
    FundingRequiredError,
    verifyWebhookSignature,
} from '../client.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal fetch Response that returns a JSON payload. */
function makeResponse(body: unknown, status = 200): Response {
    const text = JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
    } as unknown as Response;
}

/** Build a token exchange response (POST /api/auth/agent/token). */
function makeTokenResponse(): Response {
    return makeResponse({ data: { access_token: 'test-token', expires_in: 3600 } });
}

// ─── listTasks ────────────────────────────────────────────────────────────────

describe('GetterDone.listTasks()', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
    });

    it('forwards agentId as a query param when provided', async () => {
        const tasks = [{ id: 'task-1', title: 'Test task' }];
        // listTasks is authenticated: call [0] = token exchange, call [1] = listTasks
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(makeResponse({ data: tasks }));

        await gd.listTasks({ agentId: 'agent-abc', status: 'open' });

        const [url] = fetchMock.mock.calls[1] as [string, ...unknown[]];
        expect(url).toContain('agentId=agent-abc');
        expect(url).toContain('status=open');
    });

    it('does not include agentId in the query string when not provided', async () => {
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(makeResponse({ data: [] }));

        await gd.listTasks({ status: 'open' });

        const [url] = fetchMock.mock.calls[1] as [string, ...unknown[]];
        expect(url).not.toContain('agentId');
    });

    it('includes limit=50 in the query string by default', async () => {
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(makeResponse({ data: [] }));

        await gd.listTasks({});

        const [url] = fetchMock.mock.calls[1] as [string, ...unknown[]];
        expect(url).toContain('limit=50');
    });

    it('can combine agentId with q for keyword scoping', async () => {
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(makeResponse({ data: [] }));

        await gd.listTasks({ agentId: 'agent-xyz', q: 'beta', status: 'completed' });

        const [url] = fetchMock.mock.calls[1] as [string, ...unknown[]];
        expect(url).toContain('agentId=agent-xyz');
        expect(url).toContain('q=beta');
        expect(url).toContain('status=completed');
    });

    it('sends the cancelled status filter correctly', async () => {
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(makeResponse({ data: [] }));

        await gd.listTasks({ status: 'cancelled' });

        const [url] = fetchMock.mock.calls[1] as [string, ...unknown[]];
        expect(url).toContain('status=cancelled');
    });
});

// ─── 401 auto-retry ──────────────────────────────────────────────────────────

describe('request() — 401 auto-retry', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
    });

    it('clears tokenCache and retries once on 401, succeeding with fresh token', async () => {
        const tasks = [{ id: 'task-1', title: 'Test task' }];
        // call [0]: initial token exchange
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        // call [1]: listTasks returns 401 (e.g. token was revoked server-side)
        fetchMock.mockResolvedValueOnce(makeResponse({ error: 'Unauthorized' }, 401));
        // call [2]: retry token exchange (cache was cleared)
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        // call [3]: retry listTasks succeeds
        fetchMock.mockResolvedValueOnce(makeResponse({ data: tasks }));

        const result = await gd.listTasks({ agentId: 'agent-abc' });

        expect(result).toEqual(tasks);
        expect(fetchMock).toHaveBeenCalledTimes(4);
        // tokenCache should be populated again after successful retry
        expect((gd as unknown as { tokenCache: unknown }).tokenCache).not.toBeNull();
    });

    it('throws AuthenticationError if the retry also returns 401', async () => {
        // call [0]: initial token exchange
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        // call [1]: listTasks returns 401
        fetchMock.mockResolvedValueOnce(makeResponse({ error: 'Unauthorized' }, 401));
        // call [2]: retry token exchange
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        // call [3]: retry listTasks also returns 401
        fetchMock.mockResolvedValueOnce(makeResponse({ error: 'Unauthorized' }, 401));

        await expect(gd.listTasks()).rejects.toThrow(AuthenticationError);
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('tokenCache is null after the first 401 before retry completes', async () => {
        let cacheDuringRetry: unknown;

        // call [0]: initial token exchange
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        // call [1]: returns 401 — after this, tokenCache should be null
        fetchMock.mockResolvedValueOnce(makeResponse({ error: 'Unauthorized' }, 401));
        // call [2]: token exchange for retry — capture tokenCache state before it's set
        fetchMock.mockImplementationOnce(() => {
            cacheDuringRetry = (gd as unknown as { tokenCache: unknown }).tokenCache;
            return Promise.resolve(makeTokenResponse());
        });
        // call [3]: retry succeeds
        fetchMock.mockResolvedValueOnce(makeResponse({ data: [] }));

        await gd.listTasks();

        expect(cacheDuringRetry).toBeNull();
    });
});

// ─── ConflictError / AgentNameTakenError alias ───────────────────────────────

describe('ConflictError (409)', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
    });

    it('throws ConflictError on a 409 response', async () => {
        // checkAgentName is unauthenticated (no token exchange)
        fetchMock.mockResolvedValueOnce(makeResponse({ error: 'Agent name already taken' }, 409));

        await expect(gd.checkAgentName('taken-name')).rejects.toThrow(ConflictError);
    });

    it('AgentNameTakenError alias satisfies instanceof ConflictError', async () => {
        fetchMock.mockResolvedValueOnce(makeResponse({ error: 'Agent name already taken' }, 409));

        let thrown: unknown;
        try {
            await gd.checkAgentName('taken-name');
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(ConflictError);
        // The alias IS the same class, so instanceof works for both
        expect(thrown).toBeInstanceOf(AgentNameTakenError);
    });

    it('ConflictError has the correct statusCode', async () => {
        fetchMock.mockResolvedValueOnce(makeResponse({ error: 'conflict' }, 409));

        let thrown: unknown;
        try {
            await gd.checkAgentName('x');
        } catch (e) {
            thrown = e;
        }

        expect((thrown as ConflictError).statusCode).toBe(409);
    });
});

// ─── uploadAttachment ─────────────────────────────────────────────────────────

describe('GetterDone.uploadAttachment()', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
    });

    it('POSTs to the correct URL with filename and options in the body', async () => {
        // call [0]: token exchange, call [1]: uploadAttachment
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(
            makeResponse({ data: { attachmentId: 'att_abc' } })
        );

        const result = await gd.uploadAttachment('task_123', 'photo.jpg', {
            fileUrl: 'https://example.com/photo.jpg',
            mimeType: 'image/jpeg',
        });

        // Verify URL
        const [url] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(url).toBe('https://test.example/api/tasks/task_123/attachments');

        // Verify body
        const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
            filename: 'photo.jpg',
            fileUrl: 'https://example.com/photo.jpg',
            mimeType: 'image/jpeg',
        });

        // Verify return value
        expect(result).toEqual({ attachmentId: 'att_abc' });
    });

    it('includes only filename when no options are provided', async () => {
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(
            makeResponse({ data: { attachmentId: 'att_xyz' } })
        );

        await gd.uploadAttachment('task_456', 'document.pdf');

        const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ filename: 'document.pdf' });
    });

    it('sends an Authorization header (authenticated=true)', async () => {
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(
            makeResponse({ data: { attachmentId: 'att_auth' } })
        );

        await gd.uploadAttachment('task_789', 'img.png', { fileData: 'base64data' });

        const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer test-token');
    });
});

// ─── getPendingReviews ────────────────────────────────────────────────────────

describe('GetterDone.getPendingReviews()', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
    });

    it('GETs /api/tasks with status=submitted&limit=50', async () => {
        // call [0]: token exchange, call [1]: getPendingReviews
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(
            makeResponse({
                data: [{ id: 't1', status: 'submitted', title: 'Task 1' }],
            })
        );

        const result = await gd.getPendingReviews();

        const [url] = fetchMock.mock.calls[1] as [string, ...unknown[]];
        expect(url).toContain('/api/tasks');
        expect(url).toContain('status=submitted');
        expect(url).toContain('limit=50');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('t1');
    });

    it('sends an Authorization header (authenticated=true)', async () => {
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(makeResponse({ data: [] }));

        await gd.getPendingReviews();

        const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer test-token');
    });

    it('returns an empty array when no submitted tasks exist', async () => {
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(makeResponse({ data: [] }));

        const result = await gd.getPendingReviews();
        expect(result).toEqual([]);
    });
});

// ─── verifyWebhookSignature ───────────────────────────────────────────────────

describe('verifyWebhookSignature()', () => {
    const SECRET = 'my-webhook-secret';
    const RAW_BODY = '{"event":"task.completed","taskId":"t_abc"}';

    function makeSignature(body: string, secret: string): string {
        return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    }

    it('returns true for a valid HMAC signature', () => {
        const sig = makeSignature(RAW_BODY, SECRET);
        expect(verifyWebhookSignature(RAW_BODY, sig, SECRET)).toBe(true);
    });

    it('returns false when the body has been tampered with', () => {
        const sig = makeSignature(RAW_BODY, SECRET);
        const tamperedBody = '{"event":"task.completed","taskId":"t_EVIL"}';
        expect(verifyWebhookSignature(tamperedBody, sig, SECRET)).toBe(false);
    });

    it('returns false when the wrong secret is used', () => {
        const sig = makeSignature(RAW_BODY, SECRET);
        expect(verifyWebhookSignature(RAW_BODY, sig, 'wrong-secret')).toBe(false);
    });

    it('returns false when the header is missing the sha256= prefix', () => {
        const hexOnly = createHmac('sha256', SECRET).update(RAW_BODY).digest('hex');
        // Pass raw hex without 'sha256=' prefix
        expect(verifyWebhookSignature(RAW_BODY, hexOnly, SECRET)).toBe(false);
    });

    it('returns false for an empty signature header', () => {
        expect(verifyWebhookSignature(RAW_BODY, '', SECRET)).toBe(false);
    });

    it('returns false for a malformed hex value after the prefix', () => {
        // 'sha256=' prefix present but the hex is garbage (odd-length → Buffer.from throws)
        expect(verifyWebhookSignature(RAW_BODY, 'sha256=notvalidhex!!!', SECRET)).toBe(false);
    });
});

// ─── waitForStatus ────────────────────────────────────────────────────────────

describe('GetterDone.waitForStatus()', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
    });

    it('resolves when getTask returns the target status after two misses', async () => {
        const openTask = { id: 't1', status: 'open', title: 'Task' };
        const submittedTask = { id: 't1', status: 'submitted', title: 'Task' };

        // Spy on getTask so we don't need to replicate the token-exchange machinery
        const spy = vi
            .spyOn(gd, 'getTask')
            .mockResolvedValueOnce(openTask as never)
            .mockResolvedValueOnce(openTask as never)
            .mockResolvedValueOnce(submittedTask as never);

        const result = await gd.waitForStatus('t1', 'submitted', {
            pollMs: 5,
            timeoutMs: 10_000,
        });

        expect(result).toEqual(submittedTask);
        expect(spy).toHaveBeenCalledTimes(3);
        expect(spy).toHaveBeenCalledWith('t1');
    });

    it('throws GetterDoneError("Timed out waiting for status") when timeout elapses', async () => {
        const openTask = { id: 't1', status: 'open', title: 'Task' };

        vi.spyOn(gd, 'getTask').mockResolvedValue(openTask as never);

        await expect(
            gd.waitForStatus('t1', 'submitted', { pollMs: 5, timeoutMs: 30 })
        ).rejects.toThrow('Timed out waiting for status');
    });

    it('timeout error is an instance of GetterDoneError', async () => {
        vi.spyOn(gd, 'getTask').mockResolvedValue({ id: 't1', status: 'open' } as never);

        let thrown: unknown;
        try {
            await gd.waitForStatus('t1', 'submitted', { pollMs: 5, timeoutMs: 30 });
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(GetterDoneError);
    });
});

// ─── approveTask — 402 retry ──────────────────────────────────────────────────

describe('GetterDone.approveTask() — 402 retry', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
        // Replace setTimeout with an immediate version so the 1 000 ms retry delay
        // completes synchronously within the async call chain, avoiding any gap
        // between promise rejection and the test's rejection handler attachment.
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(
            (fn: TimerHandler, _delay?: number, ..._args: unknown[]) => {
                if (typeof fn === 'function') (fn as () => void)();
                return 0 as unknown as ReturnType<typeof setTimeout>;
            }
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('resolves on second attempt when first attempt returns 402 and second succeeds', async () => {
        const successBody = { task: { id: 't1', status: 'completed' }, payout: { amount: 5 } };

        // call [0]: token exchange
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        // call [1]: approveTask → 402 (balance temporarily insufficient)
        fetchMock.mockResolvedValueOnce(
            makeResponse({ error: 'Insufficient balance' }, 402)
        );
        // call [2]: retry approveTask (same token reused — 402 does not clear token cache)
        fetchMock.mockResolvedValueOnce(makeResponse({ data: successBody }));

        const result = await gd.approveTask('t1');

        expect(result).toEqual(successBody);
        // 1 token exchange + 2 approveTask attempts = 3 fetch calls total
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws InsufficientBalanceError when both attempts return 402 with balance error', async () => {
        // call [0]: token exchange
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        // call [1]: first approveTask → 402
        fetchMock.mockResolvedValueOnce(
            makeResponse({ error: 'Insufficient balance' }, 402)
        );
        // call [2]: retry approveTask → 402 again
        fetchMock.mockResolvedValueOnce(
            makeResponse({ error: 'Insufficient balance' }, 402)
        );

        await expect(gd.approveTask('t1')).rejects.toThrow(InsufficientBalanceError);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws FundingRequiredError when both attempts return 402 with funding error', async () => {
        // call [0]: token exchange
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        // call [1]: first approveTask → 402 funding
        fetchMock.mockResolvedValueOnce(
            makeResponse(
                { error: 'Funding required to proceed', onboardingUrl: 'https://onboard.me' },
                402
            )
        );
        // call [2]: retry → 402 funding again
        fetchMock.mockResolvedValueOnce(
            makeResponse(
                { error: 'Funding required to proceed', onboardingUrl: 'https://onboard.me' },
                402
            )
        );

        let thrown: unknown;
        try {
            await gd.approveTask('t1');
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(FundingRequiredError);
        expect((thrown as FundingRequiredError).onboardingUrl).toBe('https://onboard.me');
    });

    it('does NOT retry on non-402 errors (e.g. 422 TaskStateError)', async () => {
        // call [0]: token exchange
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        // call [1]: approveTask → 422
        fetchMock.mockResolvedValueOnce(
            makeResponse({ error: 'Task is not in submitted state' }, 422)
        );

        await expect(gd.approveTask('t1')).rejects.toThrow('Task is not in submitted state');
        // Only 2 fetch calls: token + 1 attempt (no retry)
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

// ─── getBalance ───────────────────────────────────────────────────────────────

describe('GetterDone.getBalance()', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns all 5 Balance fields including name and tasksCreated', async () => {
        const balancePayload = {
            balance: 94.00,
            pendingEscrow: 6.00,
            currency: 'USD',
            name: 'Test Agent',
            tasksCreated: 12,
        };
        // getBalance is authenticated: call [0] = token exchange, call [1] = getBalance
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(makeResponse({ data: balancePayload }));

        const result = await gd.getBalance();

        expect(result.balance).toBe(94.00);
        expect(result.pendingEscrow).toBe(6.00);
        expect(result.currency).toBe('USD');
        expect(result.name).toBe('Test Agent');
        expect(result.tasksCreated).toBe(12);
    });

    it('hits the correct endpoint', async () => {
        fetchMock.mockResolvedValueOnce(makeTokenResponse());
        fetchMock.mockResolvedValueOnce(
            makeResponse({
                data: {
                    balance: 0,
                    pendingEscrow: 0,
                    currency: 'USD',
                    name: 'Agent',
                    tasksCreated: 0,
                },
            })
        );

        await gd.getBalance();

        const [url] = fetchMock.mock.calls[1] as [string, ...unknown[]];
        expect(url).toBe('https://test.example/api/agents/balance');
    });
});

// ─── 409 error dispatch ───────────────────────────────────────────────────────

describe('409 error dispatch', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    // Token response reused across authenticated-call tests
    const tokenResponse = makeResponse({
        data: { access_token: 'fake-token', expires_in: 3600 },
    });

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
    });

    it('cancelTask 409 with cancel message throws TaskStateError', async () => {
        // Authenticated endpoint: fetch[0] = token, fetch[1] = cancel 409
        fetchMock
            .mockResolvedValueOnce(tokenResponse)
            .mockResolvedValueOnce(makeResponse({ error: 'Cannot cancel a claimed task' }, 409));

        await expect(gd.cancelTask('task_123')).rejects.toThrow(TaskStateError);
        await expect(gd.cancelTask('task_123')).rejects.not.toThrow(AgentNameTakenError);
    });

    it('409 with name-conflict message still throws AgentNameTakenError', async () => {
        // Authenticated endpoint: fetch[0] = token (already cached), fetch[1] = 409
        fetchMock
            .mockResolvedValueOnce(tokenResponse)
            .mockResolvedValueOnce(makeResponse({ error: 'Agent name already taken' }, 409));

        await expect(gd.cancelTask('task_123')).rejects.toThrow(AgentNameTakenError);
    });

    it('409 with unknown message throws TaskStateError as safe default', async () => {
        // Authenticated endpoint: fetch[0] = token (already cached), fetch[1] = 409
        fetchMock
            .mockResolvedValueOnce(tokenResponse)
            .mockResolvedValueOnce(makeResponse({ error: 'Generic conflict' }, 409));

        await expect(gd.cancelTask('task_123')).rejects.toThrow(TaskStateError);
        await expect(gd.cancelTask('task_123')).rejects.not.toThrow(AgentNameTakenError);
    });

    it('cancelTask 409 TaskStateError has statusCode 409', async () => {
        fetchMock
            .mockResolvedValueOnce(tokenResponse)
            .mockResolvedValueOnce(makeResponse({ error: 'Cannot cancel a claimed task' }, 409));
        try {
            await gd.cancelTask('task_123');
        } catch (e: any) {
            expect(e.statusCode).toBe(409);
        }
    });
});

// ─── 402 error disambiguation ─────────────────────────────────────────────────
// The backend emits two distinct 402 semantics:
//   1. "insufficient balance, but you have an active funding token" — wallet
//      is short, the agent should call fundAccount() to draw from the token.
//   2. "funding required" — the agent-owner hasn't finished onboarding.
//
// The SDK previously disambiguated by string-matching the word "funding" in
// the message, which would misroute new backends that legitimately include
// the phrase "funding token" in the helpful balance-shortfall hint. These
// tests lock in the structured-`code` routing and the legacy fallback.

describe('GetterDone — 402 routing', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
        // Prime the token cache so createTask doesn't trigger a token exchange.
        // First fetch call will be the POST /api/tasks we want to assert on.
        (gd as unknown as { tokenCache: { token: string; expiresAt: number } }).tokenCache = {
            token: 'fake-token',
            expiresAt: Date.now() + 60_000,
        };
    });

    const TASK = {
        title: 'Photograph storefront',
        description: 'Take a clear photo of the entrance.',
        reward: 22,
        location: { lat: 40.7128, lng: -74.006, label: '42 Main St, NYC' },
    };

    it('throws InsufficientBalanceError with fundingToken + needed/available when code=INSUFFICIENT_BALANCE_FUNDABLE', async () => {
        fetchMock.mockResolvedValueOnce(makeResponse({
            success: false,
            error: 'Insufficient balance: need $26.40, have $0.00. An active funding token authorises up to $50.00 — call fund_account to draw from it before creating the task.',
            code: 'INSUFFICIENT_BALANCE_FUNDABLE',
            needed: 26.40,
            available: 0,
            fundingToken: { id: 'gd_fund_kapqm3dt', amountUsd: 50, recurring: true },
        }, 402));

        let caught: unknown;
        try { await gd.createTask(TASK); } catch (e) { caught = e; }

        expect(caught).toBeInstanceOf(InsufficientBalanceError);
        expect(caught).not.toBeInstanceOf(FundingRequiredError);
        const err = caught as InsufficientBalanceError;
        expect(err.needed).toBe(26.40);
        expect(err.available).toBe(0);
        expect(err.fundingToken).toEqual({ id: 'gd_fund_kapqm3dt', amountUsd: 50, recurring: true });
        // recommendedDrawAmount: shortfall $26.40 capped by token limit $50 → $26.40
        expect(err.recommendedDrawAmount()).toBeCloseTo(26.40, 2);
    });

    it('recommendedDrawAmount clamps to the token limit when shortfall exceeds it', async () => {
        fetchMock.mockResolvedValueOnce(makeResponse({
            success: false,
            error: 'Insufficient balance: need $80.00, have $10.00. An active funding token authorises up to $50.00 — call fund_account to draw from it before creating the task.',
            code: 'INSUFFICIENT_BALANCE_FUNDABLE',
            needed: 80,
            available: 10,
            fundingToken: { id: 'gd_fund_abc', amountUsd: 50, recurring: true },
        }, 402));

        let caught: unknown;
        try { await gd.createTask({ ...TASK, reward: 75 }); } catch (e) { caught = e; }

        const err = caught as InsufficientBalanceError;
        // Shortfall $70 capped by token limit $50
        expect(err.recommendedDrawAmount()).toBe(50);
    });

    it('recommendedDrawAmount returns null when no funding token is present', async () => {
        fetchMock.mockResolvedValueOnce(makeResponse({
            success: false,
            error: 'Insufficient balance: need $26.40, have $0.00',
            needed: 26.40,
            available: 0,
        }, 402));

        let caught: unknown;
        try { await gd.createTask(TASK); } catch (e) { caught = e; }

        const err = caught as InsufficientBalanceError;
        expect(err.fundingToken).toBeUndefined();
        expect(err.recommendedDrawAmount()).toBeNull();
    });

    it('throws FundingRequiredError via legacy string-match when no code is present', async () => {
        fetchMock.mockResolvedValueOnce(makeResponse({
            success: false,
            error: 'No active funding token found. Complete AgentOwner setup at /agent-owner to fund this agent.',
            onboardingUrl: 'https://getterdone.ai/agent-owner',
        }, 402));

        let caught: unknown;
        try { await gd.createTask(TASK); } catch (e) { caught = e; }

        expect(caught).toBeInstanceOf(FundingRequiredError);
        expect((caught as FundingRequiredError).onboardingUrl).toBe('https://getterdone.ai/agent-owner');
    });

    it('throws plain InsufficientBalanceError when no code and no "funding" in message', async () => {
        fetchMock.mockResolvedValueOnce(makeResponse({
            success: false,
            error: 'Insufficient balance: need $26.40, have $0.00',
        }, 402));

        let caught: unknown;
        try { await gd.createTask(TASK); } catch (e) { caught = e; }

        expect(caught).toBeInstanceOf(InsufficientBalanceError);
        expect((caught as InsufficientBalanceError).fundingToken).toBeUndefined();
    });
});
