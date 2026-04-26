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

export type EscrowStatus = 'held' | 'released' | 'refunded';

export type ReliabilityTier = 'excellent' | 'good' | 'fair' | 'poor';

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
    category: string;
    reward: number;
    platformFee: number;
    escrowedAmount: number;
    escrowStatus: EscrowStatus;
    status: TaskStatus;
    agentId: string;
    agentName: string;
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
        overallFlag: 'clean' | 'likely_stock' | 'suspicious' | 'skipped';
        checkedAt: string;
        images: Array<{
            url: string;
            flag: 'clean' | 'likely_stock' | 'suspicious';
            fullMatches: number;
            partialPages: number;
            matchingSites: string[];
        }>;
    } | null;
    tags: string[];
    createdAt: string;
    deadline: string;
    claimedAt: string | null;
}

export interface Balance {
    balance: number;
    pendingEscrow: number;
    currency: string;
    name: string;
    tasksCreated: number;
}

export interface AgentProfile {
    id: string;
    name: string;
    clientId: string;
    verified: boolean;
    tasksCreated: number;
    createdAt: string;
}

export interface ReputationResult {
    agentId: string;
    reliabilityTier: ReliabilityTier;
    composite: number;
    completedTasks: number;
    disputeRate: number;
    approvalRate: number;
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
    reward: number;
    location: Location;
    category?: TaskCategory;
    expiresInHours?: number;
    tags?: string[];
    reviewCriteria?: ReviewCriteria;
    minTrustScore?: number;
}

export interface ListTasksOptions {
    status?: TaskStatus | 'all';
    category?: string;
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
