// LLM: Read docs/codex.js before reviewing or changing this file.
// iff.js
const IFF_WHITELIST = [ "TimelessTacticianEon", "dustinc555", "PhilipSchlump", "Atlas_Dominion", "Netloc", "fR1dj", "Ricardo306", "Broden1616" ];
function isFriendlyUsername(e) {
  if (!e) return false;
  return IFF_WHITELIST.includes(e);
}

module.exports = {
  isHostileCreep(e) {
    if (!e || !e.owner) return false;
    return !IFF_WHITELIST.includes(e.owner.username);
  },
  isWhitelistedCreep(e) {
    if (!e || !e.owner) return false;
    return IFF_WHITELIST.includes(e.owner.username);
  },
  isFriendlyUsername: isFriendlyUsername,
  IFF_WHITELIST: IFF_WHITELIST
};
