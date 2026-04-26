/**
 * Tests for cancelTask and approveTask envelope shapes, and TaskStatus spelling.
 *
 * Both routes return a { task, refunded|payout } wrapper (not a bare Task), and
 * the server emits 'cancelled' (double-l). These tests confirm the SDK types
 * and runtime behaviour match those server contracts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetterDone } from '../client.js';
import type { CancelTaskResult, ApproveTaskResult, TaskStatus } from '../types.js';

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

/** A minimal Task payload returned by the server after cancellation. */
const cancelledTask = {
    id: 'task_123',
    title: 'Test Task',
    description: 'A test task',
    category: 'General',
    reward: 8.00,
    platformFee: 0.80,
    escrowedAmount: 8.80,
    escrowStatus: 'refunded',
    status: 'cancelled',
    agentId: 'agent_abc',
    agentName: 'Test Agent',
    workerId: null,
    workerNickname: null,
    location: { lat: 0, lng: 0, label: 'Remote', remote: true },
    tags: [],
    createdAt: '2024-01-01T00:00:00Z',
    deadline: '2024-01-02T00:00:00Z',
    claimedAt: null,
};

/** A minimal Task payload returned by the server after approval. */
const completedTask = {
    ...cancelledTask,
    status: 'completed',
    escrowStatus: 'released',
};

// ─── cancelTask ───────────────────────────────────────────────────────────────

describe('GetterDone.cancelTask()', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
    });

    it('returns { task, refunded } with the correct envelope shape', async () => {
        // First call: token exchange; second call: the actual cancel request.
        fetchMock
            .mockResolvedValueOnce(
                makeResponse({ data: { access_token: 'tok', expires_in: 3600 } })
            )
            .mockResolvedValueOnce(
                makeResponse({
                    success: true,
                    data: { task: cancelledTask, refunded: 8.00 },
                })
            );

        const result: CancelTaskResult = await gd.cancelTask('task_123');

        expect(result.task.status).toBe('cancelled');
        expect(result.task.id).toBe('task_123');
        expect(result.refunded).toBe(8.00);
    });

    it('result does not have a top-level status field (it lives on result.task)', async () => {
        fetchMock
            .mockResolvedValueOnce(
                makeResponse({ data: { access_token: 'tok', expires_in: 3600 } })
            )
            .mockResolvedValueOnce(
                makeResponse({
                    success: true,
                    data: { task: cancelledTask, refunded: 8.00 },
                })
            );

        const result = await gd.cancelTask('task_123');

        // Top-level result has no .status — it's a CancelTaskResult, not a Task
        expect((result as unknown as Record<string, unknown>).status).toBeUndefined();
        expect(result.task.status).toBe('cancelled');
    });

    it('calls POST /api/tasks/{id}/cancel', async () => {
        fetchMock
            .mockResolvedValueOnce(
                makeResponse({ data: { access_token: 'tok', expires_in: 3600 } })
            )
            .mockResolvedValueOnce(
                makeResponse({ success: true, data: { task: cancelledTask, refunded: 8.00 } })
            );

        await gd.cancelTask('task_123');

        const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(url).toContain('/api/tasks/task_123/cancel');
        expect(init.method).toBe('POST');
    });
});

// ─── approveTask ──────────────────────────────────────────────────────────────

describe('GetterDone.approveTask()', () => {
    let gd: GetterDone;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });
    });

    it('returns { task, payout } with the correct envelope shape', async () => {
        fetchMock
            .mockResolvedValueOnce(
                makeResponse({ data: { access_token: 'tok', expires_in: 3600 } })
            )
            .mockResolvedValueOnce(
                makeResponse({
                    success: true,
                    data: {
                        task: completedTask,
                        payout: { workerId: 'worker_1', amount: 8.00, currency: 'usd' },
                    },
                })
            );

        const result: ApproveTaskResult = await gd.approveTask('task_123');

        expect(result.task).toBeDefined();
        expect(result.task.id).toBe('task_123');
        expect(result.task.status).toBe('completed');
        expect(result.payout).toBeDefined();
        expect(result.payout.amount).toBe(8.00);
        expect(result.payout.workerId).toBe('worker_1');
        expect(result.payout.currency).toBe('usd');
    });

    it('payout is a PayoutResult object with amount, workerId, currency', async () => {
        fetchMock
            .mockResolvedValueOnce(
                makeResponse({ data: { access_token: 'tok', expires_in: 3600 } })
            )
            .mockResolvedValueOnce(
                makeResponse({
                    success: true,
                    data: {
                        task: completedTask,
                        payout: { workerId: 'worker_1', amount: 12.50, currency: 'usd' },
                    },
                })
            );

        const result = await gd.approveTask('task_123');

        expect(typeof result.payout).toBe('object');
        expect(result.payout.amount).toBe(12.50);
    });

    it('calls POST /api/tasks/{id}/complete', async () => {
        fetchMock
            .mockResolvedValueOnce(
                makeResponse({ data: { access_token: 'tok', expires_in: 3600 } })
            )
            .mockResolvedValueOnce(
                makeResponse({
                    success: true,
                    data: {
                        task: completedTask,
                        payout: { workerId: 'worker_1', amount: 8.00, currency: 'usd' },
                    },
                })
            );

        await gd.approveTask('task_123');

        const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(url).toContain('/api/tasks/task_123/complete');
        expect(init.method).toBe('POST');
    });
});

// ─── TaskStatus spelling ──────────────────────────────────────────────────────

describe('TaskStatus', () => {
    it("includes 'cancelled' (double-l) in the union", () => {
        // This is a compile-time check encoded as a runtime assertion.
        // The const assignment below would cause a TypeScript error if
        // 'cancelled' were not a valid TaskStatus.
        const status: TaskStatus = 'cancelled';
        expect(status).toBe('cancelled');
    });

    it("'cancelled' round-trips correctly through a task status field", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const gd = new GetterDone({ apiKey: 'gd_testid:testsecret', baseUrl: 'https://test.example' });

        fetchMock
            .mockResolvedValueOnce(
                makeResponse({ data: { access_token: 'tok', expires_in: 3600 } })
            )
            .mockResolvedValueOnce(
                makeResponse({ success: true, data: { task: cancelledTask, refunded: 8.00 } })
            );

        const result = await gd.cancelTask('task_123');
        const status: TaskStatus = result.task.status;
        expect(status).toBe('cancelled');
    });
});
