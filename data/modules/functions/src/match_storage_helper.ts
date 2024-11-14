const systemUserId = '00000000-0000-0000-0000-000000000000'
const matchResultFinishedAtIndexName = "match_results_finished_at_index";

let initializeMatchStorageHelper = (
    initializer: nkruntime.Initializer, 
    logger: nkruntime.Logger,
) => {
    const indexName = matchResultFinishedAtIndexName;
    const collection = "match_results";
    const key = ""; // Index all objects in the collection
    const fields = ["finishedAt"]; // Fields to index
    const sortableFields = ["finishedAt"]; // Fields that can be sorted in queries
    const maxEntries = 1000; // Adjust based on your storage needs
    const indexOnly = true; // Include full object data in the index

    try {
        initializer.registerStorageIndex(indexName, collection, key, fields, sortableFields, maxEntries, indexOnly);
        logger.info("Storage index registered successfully.");
    } catch (error) {
        logger.error("Error registering storage index: " + error);
    }
}


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

let getLastMatchId = (nk: nkruntime.Nakama): string => {
    const indexName = matchResultFinishedAtIndexName;
    const query = ""; // No specific filter, fetch all entries
    const limit = 1; // Only need the most recent entry
    const order = ["-value.finishedAt"]; // Sort by finishedAt in descending order

    try {
        let results = nk.storageIndexList(indexName, query, limit, order);
        if (results.length > 0) {
            return results[0].key; // Get the key of the latest match result
        } else {
            throw new Error("No match results found");
        }
    } catch (error) {
        throw new Error("Error fetching last match ID: " + error);
    }
};