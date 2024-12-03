interface MatchState {
    playingTickRate: number;
    playingTickNumber: number;
    pipesDistance: number;
    pipesNormalizedYPositions: number[];
    pipesHoleGap: number;
    pipesYRange: number;
    pipeWidth: number;
    matchInitializedAt: number;
    matchRunsAt: number;
    matchFinishesAt: number;
    currentPhase: MatchPhase;
    presences: nkruntime.Presence[];
    gravityY: number;
    players: { [key: string]: PlayerInfo };
    playersInitialXSpeed: number;
    matchIsEmptySince?: number;
    matchFinishTextSent: boolean;
    playerSpawnsAgainAfter: number;
}

interface PlayerInfo {
    isInLobby: boolean;
    x: number;
    y: number;
    velocityX: number;
    velocityY: number;
    score: number;
    diedCount: number;
    playingState: PlayingState;
    displayName: string;
    userId: string;
    spawnsAgainIn: number;
    lastPing: number;
    jumpForce: number;
}

enum MatchPhase {
    WaitingForPlayers,
    Running,
    Finished,
}

enum PlayingState {
    Idle,
    Playing,
    Died,
}
