enum MatchOpCode {
    // Match
    MatchWelcome = 100,
    MatchWaitingTimeIncreased = 101,
    MatchPlayersJoined = 102,
    MatchPlayersLeft = 103,
    MatchPlayerNameUpdated = 104,
    MatchStarted = 105,
    MatchFinished = 106,
    MatchPing = 107,
    MatchPong = 108,

    // Player
    PlayerJoinedTheLobby = 200,
    PlayerTickUpdate = 201,
    PlayerStarted = 202,
    PlayerJumped = 203,
    PlayerScored = 204,
    PlayerDied = 205,
    PlayerKickedFromLobby = 206,
    PlayerFullStateNeeded = 207,
}