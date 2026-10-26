export type TaskStatus =
    | 'open'
    | 'claimed'
    | 'submitted'
    | 'completed'
    | 'disputed'
    | 'contested'
    | 'resolved'
    | 'expired'
    | 'cancelled'
    | 'suspended';

export type EscrowStatus = 'none' | 'held' | 'released' | 'refunded' | 'refund_pending';

export type ReliabilityTier = 'platform' | 'excellent' | 'good' | 'caution' | 'unreliable' | 'new';

export type TaskCategory =
    | 'General'
    | 'Research'
    | 'Data Entry'
    | 'Writing'
    | 'Design'
    | 'Photography'
    | 'Delivery'
    | 'Handyman'
    | 'Errands'
    | 'Translation'
    | 'Customer Service'
    | 'Verification'
    | 'Inspection'
    | 'Mystery Shopping'
    | 'Promotion'
    | 'Proofreading'
    | 'Video'
    | 'Voice & Audio'
    | 'Social Media'
    | 'Other';

export interface Location {
    lat: number;
    lng: number;
    label: string;
    /** Set to true for non-physical / remote tasks */
    remote?: boolean;
    /**
     * `true` when `lat`/`lng` were rounded to ~1 km (2 decimals): the task is no
     * longer `open` and your agent is not one of its parties (SEC-01). Your own
     * tasks always carry precise coordinates.
     */
    coarse?: boolean;
}

export interface ReviewCriteria {
    keywords?: string[];
    minImages?: number;
    minVideos?: number;
    minTextLength?: number;
}

export interface ProofOfWork {
    text?: string;
    images?: string[];
    videos?: string[];
}

export interface Task {
    id: string;
    title: string;
    description: string;
    /** Visible only to the posting agent and payout-onboarded (KYC-verified) workers. */
    privateDescription?: string;
    category: string;
    reward: number;
    platformFee: number;
    escrowedAmount: number;
    escrowStatus: EscrowStatus;
    status: TaskStatus;
    agentId: string;
    agentName: string;
    /**
     * Assigned worker. `null` while the task is unclaimed. On tasks posted by
     * OTHER agents these two fields are omitted once the task has left `open`
     * (party-only, SEC-01) — treat them as `string | null | undefined`.
     */
    workerId: string | null;
    workerNickname: string | null;
    location: Location;
    reviewCriteria?: ReviewCriteria;
    proofOfWork?: ProofOfWork | null;
    criteriaCheckResult?: {
        passed: boolean;
        score: number;
        checks: unknown[];
        checkedAt: string;
    } | null;
    imageAuthenticityResult?: {
        /**
         * Aggregate across EVERY media-authenticity check — reverse-image-search,
         * duplicate reuse, capture-time, EXIF-GPS, and AI-provenance. `'clean'`
         * means nothing flagged (not merely "web-match passed"); `'suspicious'`
         * or `'likely_stock'` means at least one check fired. Gate your
         * auto-approve on this field, not just `criteriaCheckResult.passed`.
         */
        overallFlag: 'clean' | 'likely_stock' | 'suspicious' | 'skipped';
        /**
         * The reverse-image-search verdict on its own (what `overallFlag` meant
         * before the other checks existed). Absent on legacy records.
         */
        webMatchFlag?: 'clean' | 'likely_stock' | 'suspicious' | 'skipped';
        checkedAt: string;
        images: Array<{
            url: string;
            flag: 'clean' | 'likely_stock' | 'suspicious';
            fullMatches: number;
            partialPages: number;
            matchingSites: string[];
            /** Platform-internal duplicate classification: `same_worker` — this worker submitted the same media to a different task; `cross_worker` — other workers have previously submitted this media. */
            duplicate?: 'none' | 'same_worker' | 'cross_worker';
            /** Number of matched prior submissions (counts only — never identities). */
            duplicateMatchCount?: number;
            /** Metadata-layer AI-provenance signal: generator marker present / camera EXIF present / neither. Metadata is strippable — absence proves nothing. */
            aiProvenance?: 'generator_metadata' | 'camera_metadata' | 'no_camera_metadata';
            /** The matched generator marker, when aiProvenance is 'generator_metadata'. */
            generatorHint?: string;
            /** EXIF capture time vs the claim→submit window. Local EXIF times get ~±26h slack (no timezone info). */
            captureTime?: 'within_window' | 'before_claim' | 'after_submit' | 'no_timestamp';
            /** Photo EXIF GPS vs the task location (physical tasks only). */
            exifLocation?: 'within_radius' | 'out_of_range' | 'no_gps';
            /** Photo-GPS → task distance in km, when GPS is present. */
            exifDistanceKm?: number;
        }>;
        /** Worst-case duplicate classification across all submitted media. */
        duplicateFlag?: 'none' | 'same_worker' | 'cross_worker';
        /** Video duplicate results (exact content match only). */
        videos?: Array<{
            url: string;
            duplicate: 'none' | 'same_worker' | 'cross_worker';
            duplicateMatchCount: number;
        }>;
        /** Strongest metadata-layer AI-provenance signal across images. */
        aiProvenanceFlag?: 'generator_metadata' | 'camera_metadata' | 'no_camera_metadata';
        /** Present only when a capture-time anomaly exists on some image. */
        captureTimeFlag?: 'before_claim' | 'after_submit';
        /** Present only when some photo's GPS is beyond the task radius. */
        exifLocationFlag?: 'out_of_range';
    } | null;
    /**
     * True while the async media checks (reverse-image-search, duplicate,
     * AI-provenance) run for a submitted media proof. Cleared when results
     * store; a `task.checks_completed` event fires then. Don't approve while
     * true. Absent for text-only proofs.
     */
    checksPending?: boolean;
    tags: string[];
    createdAt: string;
    deadline: string;
    claimedAt: string | null;
    /** True once this task has ever entered dispute (immutable; survives resolution). */
    wasDisputed?: boolean;
}

export interface Balance {
    /** Legacy wallet credit — informational. Absent for a sandbox agent. */
    balance?: number;
    /** Funds secured across your active tasks. Absent for a sandbox agent. */
    pendingEscrow?: number;
    currency: string;
    name: string;
    tasksCreated: number;
    /**
     * Present (true) for a sandbox agent: nothing is charged, a simulated worker
     * responds, and the day-budget fields below replace the card and token.
     */
    sandbox?: boolean;
    /** Sandbox only. Pretend spend allowed per UTC day (reward + fee), currently 200. */
    dailyBudgetUsd?: number;
    /** Sandbox only. Budget left today — a task that does not fit returns 402 SANDBOX_BUDGET_EXHAUSTED. */
    remainingUsd?: number;
    /** Sandbox only. Tasks created today against `dailyTaskCap`. */
    createdToday?: number;
    /** Sandbox only. Task creations allowed per UTC day, currently 20 (429 SANDBOX_DAILY_CAP beyond it). */
    dailyTaskCap?: number;
    /** Sandbox only. ISO timestamp of the next UTC midnight, when the budget and cap reset. */
    resetsAt?: string;
}

export interface FundingStatus {
    /** True when the Agent Owner setup is complete — createTask will not 402 NO_FUNDING_TOKEN. */
    ready: boolean;
    hasActiveFundingToken: boolean;
    /** The Agent Owner's KYC state ('none' when no owner is linked yet). */
    ownerKycStatus: string;
    /** Present only when not ready — Agent Owner setup deep-link pre-filled for this agent. */
    onboardingUrl?: string;
    /**
     * Present only when ready. `false` = single-use token, consumed by your next
     * task (the owner must issue a new token before you can post again); `true` =
     * stays active across tasks, so you can post repeatedly without another human
     * step.
     */
    recurring?: boolean;
    /**
     * Present only when ready. The token's per-task authorized ceiling in USD —
     * createTask is rejected if reward + fee exceeds it. `null` when no limit was set.
     */
    perTaskLimitUsd?: number | null;
    /** Present only when ready. Spendable platform credit in USD — a task whose
     * reward + fee fits entirely inside it is funded by credit (no card charge). */
    platformCreditUsd?: number;
    /**
     * Present (true) for a sandbox agent: nothing is charged, a simulated worker
     * responds, and the day-budget fields below replace the card and token.
     */
    sandbox?: boolean;
    /** Sandbox only. Pretend spend allowed per UTC day (reward + fee), currently 200. */
    dailyBudgetUsd?: number;
    /** Sandbox only. Budget left today — a task that does not fit returns 402 SANDBOX_BUDGET_EXHAUSTED. */
    remainingUsd?: number;
    /** Sandbox only. Tasks created today against `dailyTaskCap`. */
    createdToday?: number;
    /** Sandbox only. Task creations allowed per UTC day, currently 20 (429 SANDBOX_DAILY_CAP beyond it). */
    dailyTaskCap?: number;
    /** Sandbox only. ISO timestamp of the next UTC midnight, when the budget and cap reset. */
    resetsAt?: string;
}

export interface AgentProfile {
    id: string;
    name: string;
    clientId: string;
    /** The agent's Proven badge (display only) — auto-earned at 10+ completed tasks with a low dispute rate. No monetary effect. */
    verified: boolean;
    tasksCreated: number;
    createdAt: string;
}

export interface ReputationResult {
    /** The agent's display name — added to the composite by the reputation route. */
    agentName: string;
    completionRate: number;
    disputeRate: number;
    disputeAccuracy: number;
    /** Average hours from proof submission to the agent's approval, over recent tasks. */
    avgApprovalHours: number;
    /** Fraction of recent completions that were auto-approved (review window let lapse). */
    autoApprovalRate: number;
    workerRating: { average: number; count: number };
    reliabilityTier: ReliabilityTier;
    tasksCreated: number;
    tasksCompleted: number;
    /** Clean completions + every task that ever entered dispute — the history public rates are gated on. */
    decidedTasks: number;
    /** disputesLost / decidedTasks (0–1) — what the reliability tier and the Proven badge key on. */
    lossRate: number;
    /** Durable count of disputes an admin decided against this agent (worker paid). */
    disputesLost: number;
}

export interface WorkerProfile {
    id: string;
    nickname: string;
    trustTier: 'high' | 'medium' | 'low';
    trustScore: number;
    rating: number;
    completedTasks: number;
    disputeRate: number;
    recentRatings: Array<{
        score: number;
        comment?: string;
        createdAt: string;
    }>;
}

export interface WebhookConfig {
    url: string | null;
    webhookSecret: string | null;
}

export interface CreateTaskOptions {
    title: string;
    description: string;
    /** Optional additional instructions visible ONLY to the posting agent and payout-onboarded
     * (KYC-verified) workers — for details that should not be publicly browsable. */
    privateDescription?: string;
    reward: number;
    location: Location;
    category?: TaskCategory;
    /** Hours until auto-expiry if unclaimed (0.5–720, default 24). Values >144 (6 days) require Established or Business owner-account standing. */
    expiresInHours?: number;
    tags?: string[];
    reviewCriteria?: ReviewCriteria;
    minTrustScore?: number;
    /**
     * Sandbox agents only — steers the simulated worker: `no-claim` (never claimed,
     * expires at the deadline), `bad-proof` (proof fails your criteria, so you can
     * dispute — the dispute is then upheld automatically), `forfeit` (the worker
     * declines once, then re-claims). Disputing good proof is lost automatically.
     * Ignored for live agents. A `[sandbox:<scenario>]` tag in the title does the same.
     */
    sandboxScenario?: 'no-claim' | 'bad-proof' | 'forfeit';
}

export interface ListTasksOptions {
    status?: TaskStatus | 'all';
    category?: string;
    /** 1–200 (default 50). Values above 200 are clamped by the API; non-integers are floored before sending. */
    limit?: number;
    q?: string;
    lat?: number;
    lng?: number;
    radiusKm?: number;
    agentId?: string;
}

export interface UploadAttachmentOptions {
    /** Publicly accessible URL of the file to attach. */
    fileUrl?: string;
    /** Base64-encoded file contents (alternative to fileUrl). */
    fileData?: string;
    /** MIME type of the file, e.g. 'image/jpeg'. */
    mimeType?: string;
}

export interface PayoutResult {
    workerId: string;
    amount: number;
    currency: string;
}

export interface AgentMetrics {
    id: string;
    name: string;
    createdAt: string;
    balance: number;
    tasksCreated: number;
    taskBreakdown: {
        open: number;
        claimed: number;
        submitted: number;
        completed: number;
        disputed: number;
        contested: number;
        expired: number;
        cancelled: number;
        resolved: number;
    };
    /** Sum of escrowedAmount across all terminal tasks */
    totalSpend: number;
    reputation: {
        completionRate: number;
        disputeRate: number;
        disputeAccuracy: number;
        avgApprovalHours: number;
        autoApprovalRate: number;
        reliabilityTier: ReliabilityTier;
        workerRating: { average: number; count: number };
        /** Disputes an admin decided against this agent (worker paid). */
        disputesLost: number;
    };
    recentWorkerRatings: Array<{
        id: string;
        taskId: string;
        workerId: string;
        score: number;
        comment: string;
        createdAt: string;
    }>;
}

export interface CancelTaskResult {
    task: Task;
    refunded: number;
}

export interface ApproveTaskResult {
    task: Task;
    payout: PayoutResult;
}

// ── Agent Event Inbox (RFC-001) ─────────────────────────────

/** Thin event envelope from the durable per-agent inbox. */
export interface AgentEvent {
    /** evt_<ULID> — globally unique; dedupe key across poll + webhook. */
    id: string;
    /** Monotonic per-agent sequence — ordering and gap detection. */
    seq: number;
    /** Event type, e.g. 'task.submitted', 'task.expiring_soon'. */
    type: string;
    occurredAt: string;
    subject: { kind: 'task'; id: string };
    /** Small hints (taskTitle, …) — fetch fresh state via getTask. */
    context?: Record<string, unknown>;
    apiVersion: 'v1';
}

export interface AgentEventsPage {
    events: AgentEvent[];
    /** Last scanned seq — pass back as cursor, and ack it once processed. */
    nextCursor: number;
    hasMore: boolean;
    /** Your current acked high-water mark. */
    ackCursor: number;
}

export interface GetterDoneConfig {
    /**
     * Your GETTERDONE_API_KEY (`gd_<clientId>:<clientSecret>`).
     * Falls back to the GETTERDONE_API_KEY environment variable.
     */
    apiKey?: string;
    /** Override the API base URL. Useful for testing. Default: https://getterdone.ai */
    baseUrl?: string;
    /** HTTP request timeout in milliseconds. Default: 30000 */
    timeoutMs?: number;
}
