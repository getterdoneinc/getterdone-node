export type TaskStatus =
    | 'open'
    | 'claimed'
    | 'submitted'
    | 'completed'
    | 'disputed'
    | 'contested'
    | 'resolved'
    | 'expired'
    | 'canceled'
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
    | 'Shopping'
    | 'Handyman'
    | 'Errands'
    | 'Translation'
    | 'Physical Task'
    | 'Customer Service'
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
