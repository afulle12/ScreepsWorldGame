/**
 * nukeUtils.js
 * Helper to check if a destination room is within Nuker launch range.
 * Range is 5 rooms. Uses Game.map.getRoomLinearDistance with non-continuous edges.
 * Console usage: nukeInRange('W8N3', 'W9N4')
 *
 * Notes:
 * - Nuker max launch range: 5 rooms. 【2】
 * - Room-to-room distance via Game.map.getRoomLinearDistance(room1, room2, continuous). 【1】
 */

function nukeInRange(launchRoomName, destinationRoomName) {
    if (typeof launchRoomName !== 'string' || typeof destinationRoomName !== 'string') {
        console.log('[nukeInRange] Please pass room names as strings, e.g., "W8N3".');
        return false;
    }

    var dist = Game.map.getRoomLinearDistance(launchRoomName, destinationRoomName, false);
    var maxRange = 5;
    var inRange = dist <= maxRange;

    console.log('[nukeInRange]', launchRoomName, '->', destinationRoomName,
        'distance:', dist, 'maxRange:', maxRange, 'inRange:', inRange);

    return inRange;
}

module.exports = {
    nukeInRange: nukeInRange
};
