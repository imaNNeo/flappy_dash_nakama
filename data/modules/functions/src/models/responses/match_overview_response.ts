interface MatchOverviewResponse {
    id: string;
    initializedAt: number;
    startedAt: number;
    finishedAt: number;
    scores: {
        score: number;
        user: nkruntime.User;
    }[];
}
