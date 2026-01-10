// iff.js
// Identify Friend or Foe logic, used for towers and monitoring hostiles.

const IFF_WHITELIST = [
    'tarenty',
    'TimelessTacticianEon',
    'dustinc555',
    'PhilipSchlump',
    'Atlas_Dominion',
    'AlFe'
    // Add more player usernames to whitelist here.
];

function isFriendlyUsername(username) {
    if (!username) return false;
    return IFF_WHITELIST.includes(username);
}

module.exports = {
    isHostileCreep(creep) {
        if (!creep || !creep.owner) return false;
        return !IFF_WHITELIST.includes(creep.owner.username);
    },

    isWhitelistedCreep(creep) {
        if (!creep || !creep.owner) return false;
        return IFF_WHITELIST.includes(creep.owner.username);
    },

    isFriendlyUsername,   // NEW export

    IFF_WHITELIST
};
