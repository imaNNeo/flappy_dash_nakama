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
    PlayerTickUpdate = 201,
    PlayerStarted = 202,
    PlayerJumped = 203,
    PlayerScored = 204,
    PlayerDied = 205,
    PlayerKickedFromLobby = 206,
    PlayerCorrectPosition = 207,
    PlayerDisplayNameUpdated = 208,
    PlayerWillSpawnAt = 209,
}