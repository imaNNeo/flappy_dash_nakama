enum MatchOpCode {
    // Match
    MatchWelcome = 100,
    MatchWaitingTimeIncreased = 101,
    MatchPresencesUpdated = 102,
    MatchStarted = 103,
    MatchFinished = 104,
    MatchPing = 105,
    MatchPong = 106,

    // Player
    PlayerJoinedTheLobby = 200,
    PlayerStarted = 201,
    PlayerJumped = 202,
    PlayerScored = 203,
    PlayerDied = 204,
    PlayerIsIdle = 205,
    PlayerKickedFromLobby = 206,
    PlayerCorrectPosition = 207,
    PlayerDisplayNameUpdated = 208,
    PlayerWillSpawnAt = 209,
}