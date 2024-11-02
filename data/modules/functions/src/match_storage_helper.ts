const systemUserId = '00000000-0000-0000-0000-000000000000'

let addWaitingMatch = (nk: nkruntime.Nakama, matchId: string) => {
    let storageObjects = nk.storageRead([{
        collection: "matches",
        key: "waiting_matches",
        userId: systemUserId,
    }]);


    let waitingMatches: string[] = [];

    if (storageObjects.length > 0) {
        waitingMatches = storageObjects[0].value['ids'];
    }

    if (waitingMatches.indexOf(matchId) === -1) {
        waitingMatches.push(matchId);
    }

    nk.storageWrite([{
        collection: 'matches',
        key: 'waiting_matches',
        userId: systemUserId,
        value: {
            'ids': waitingMatches,
        }
    }]);
}

let removeWaitingMatch = (nk: nkruntime.Nakama, matchId: string) => {
    let storageObjects = nk.storageRead([{
        collection: "matches",
        key: "waiting_matches",
        userId: systemUserId,
    }]);
    let waitingMatches: string[] = [];

    if (storageObjects.length > 0) {
        waitingMatches = storageObjects[0].value['ids'];
    }

    let index = waitingMatches.indexOf(matchId);
    if (index !== -1) {
        waitingMatches.splice(index, 1);
    }

    nk.storageWrite([{
        collection: 'matches',
        key: 'waiting_matches',
        userId: systemUserId,
        value: {
            'ids': waitingMatches,
        }
    }]);
}

let getWaitingMatches = (nk: nkruntime.Nakama) => {
    let storageObjects = nk.storageRead([{
        collection: "matches",
        key: "waiting_matches",
        userId: systemUserId,
    }]);

    if (storageObjects.length > 0) {
        return storageObjects[0].value['ids'];
    }

    return [];
}

let addMatchResult = (nk: nkruntime.Nakama, matchId: string, result: MatchResult) => {
    nk.storageWrite([{
        collection: 'match_results',
        key: matchId,
        userId: systemUserId,
        value: result,
    }]);
}

let getMatchResult = (nk: nkruntime.Nakama, matchId: string): MatchResult => {
    let storageObjects = nk.storageRead([{
        collection: "match_results",
        key: matchId,
        userId: systemUserId,
    }]);

    if (storageObjects.length > 0) {
        return storageObjects[0].value as MatchResult;
    }

    throw new Error('Match result not found');
}