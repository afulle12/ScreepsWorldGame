// iff.js
// Identify Friend or Foe logic, used for towers and monitoring hostiles.

const IFF_WHITELIST = [
    'tarenty',
    'TimelessTacticianEon',
    'dustinc555'
    // Add more player usernames to whitelist here.
];

module.exports = {
    isHostileCreep(creep) {
        if (!creep || !creep.owner) return false;
        return !IFF_WHITELIST.includes(creep.owner.username);
    },

    isWhitelistedCreep(creep) {
        if (!creep || !creep.owner) return false;
        return IFF_WHITELIST.includes(creep.owner.username);
    },

    IFF_WHITELIST
};