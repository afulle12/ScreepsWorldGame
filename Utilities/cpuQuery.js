// LLM: Read llmcontext.js before reviewing or changing this file.
// cpuQuery.js
// Purpose: Register CPU scheduler console commands.

const heap = require('memoryManager').heap;

global.cpuHelp = function() {
  console.log('==============================================================');
  console.log('|         CPU SCHEDULER - CONSOLE COMMANDS                  |');
  console.log('==============================================================');
  console.log('|  cpu()            Detailed scheduler status report         |');
  console.log('|  cpuHud(\'W1N1\')   Enable live RoomVisual overlay          |');
  console.log('|  cpuHud()         Disable the HUD overlay                  |');
  console.log('|  cpuJSON()        Dump stats as JSON                       |');
  console.log('==============================================================');
};

global.cpu = function() {
  const s = heap.cpuStats || {};
  console.log('==============================================================');
  console.log('|           CPU SCHEDULER STATUS                            |');
  console.log('==============================================================');
  console.log('| Bucket:     ' + (s.bucket || '?') + ' / 10000');
  console.log('| Tier:       ' + (s.lastBudgetTier || '?'));
  console.log('| Budget:     ' + (s.lastBudget ? s.lastBudget.toFixed(1) : '?') + ' CPU');
  console.log('| Pressure:   ' + (s.lastPressure || 0) + '%');
  console.log('| Avg CPU:    ' + (s.average ? s.average.toFixed(2) : '?'));
  console.log('| Throttled:  ' + (s.lastSectionsThrottled || 0) + ' sections, '
    + (s.lastCreepsThrottled || 0) + ' creeps');
  console.log('==============================================================');

  if (s.history && s.history.length > 0) {
    const recent = s.history.slice(-20);
    const max = Math.max.apply(null, recent);
    const bars = recent.map(function(v) {
      const pct = max > 0 ? v / max : 0;
      if (pct > 0.875) return '#';
      if (pct > 0.75) return '8';
      if (pct > 0.625) return '7';
      if (pct > 0.5) return '6';
      if (pct > 0.375) return '5';
      if (pct > 0.25) return '4';
      if (pct > 0.125) return '3';
      return '.';
    }).join('');
    console.log('| History:    ' + bars + ' (peak ' + max.toFixed(1) + ')');
  }

  if (heap.cpuProfile) {
    console.log('========== SECTION AVERAGES =========================');
    const entries = [];
    for (var key in heap.cpuProfile) {
      var arr = heap.cpuProfile[key];
      var avg = arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
      entries.push({ name: key, avg: avg });
    }
    entries.sort(function(a, b) { return b.avg - a.avg; });
    for (var i = 0; i < Math.min(entries.length, 15); i++) {
      var e = entries[i];
      console.log('|  ' + e.name + ': ' + e.avg.toFixed(3) + ' CPU');
    }
  }

  if (heap.cpuProfileCreeps) {
    console.log('========== CREEP ROLE AVERAGES =====================');
    var roleEntries = [];
    for (var role in heap.cpuProfileCreeps) {
      var roleArr = heap.cpuProfileCreeps[role];
      var roleAvg = roleArr.reduce(function(a, b) { return a + b; }, 0) / roleArr.length;
      roleEntries.push({ name: role, avg: roleAvg });
    }
    roleEntries.sort(function(a, b) { return b.avg - a.avg; });
    for (var j = 0; j < roleEntries.length; j++) {
      var r = roleEntries[j];
      console.log('|  ' + r.name + ': ' + r.avg.toFixed(3) + ' CPU');
    }
  }

  console.log('==============================================================');
};

global.cpuHud = function(roomName) {
  if (!roomName) {
    delete Memory.cpuHudRoom;
    console.log('[CPU HUD] Disabled.');
  } else {
    Memory.cpuHudRoom = roomName;
    console.log('[CPU HUD] Enabled on ' + roomName + '. Call cpuHud() to disable.');
  }
};

global.cpuJSON = function() {
  console.log(JSON.stringify(heap.cpuStats || {}));
};

module.exports = {};
