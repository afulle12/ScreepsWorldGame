'use strict';

// Start profiling for 100 ticks
//Game.profiler.profile(100);

// View results (tree view, default)
//Game.profiler.output();

// View flat results (old style)
//Game.profiler.flat();

// Profile specific functions only
//Game.profiler.profile(100, ['runCreeps', 'runTowers']);

// Reset data
//Game.profiler.reset();


let usedOnStart = 0;
let enabled = false;
let depth = 0;

const parentStack = ['(tick)'];

class ProfilerError extends Error {}

// Hack to ensure the InterShardMemory constant exists in sim
try {
  // eslint-disable-next-line no-unused-expressions
  InterShardMemory;
} catch (e) {
  global.InterShardMemory = undefined;
}

function setupProfiler() {
  depth = 0; // reset depth, this needs to be done each tick.
  parentStack.length = 0;
  parentStack.push('(tick)');
  Game.profiler = {
    stream(duration, filter) {
      setupMemory('stream', duration || 10, filter);
    },
    email(duration, filter) {
      setupMemory('email', duration || 100, filter);
    },
    profile(duration, filter) {
      setupMemory('profile', duration || 100, filter);
    },
    background(filter) {
      setupMemory('background', false, filter);
    },
    callgrind(duration, filter) {
      setupMemory('callgrind', duration || 100, filter);
    },
    restart() {
      if (Profiler.isProfiling()) {
        const filter = Memory.profiler.filter;
        let duration = false;
        if (!!Memory.profiler.disableTick) {
          // Calculate the original duration, profile is enabled on the tick after the first call,
          // so add 1.
          duration = Memory.profiler.disableTick - Memory.profiler.enabledTick + 1;
        }
        const type = Memory.profiler.type;
        setupMemory(type, duration, filter);
      }
    },
    reset: resetMemory,
    output: Profiler.output,
    flat: Profiler.flat,
    downloadCallgrind: Profiler.downloadCallgrind,
  };

  overloadCPUCalc();
}

function setupMemory(profileType, duration, filter) {
  resetMemory();
  const disableTick = Number.isInteger(duration) ? Game.time + duration : false;
  if (!Memory.profiler) {
    Memory.profiler = {
      map: {},
      totalTime: 0,
      enabledTick: Game.time + 1,
      disableTick,
      type: profileType,
      filter,
    };
  }
  console.log(`Profiling type ${profileType} started at ${Game.time + 1} for ${duration} ticks`);
}

function resetMemory() {
  Memory.profiler = null;
}

function overloadCPUCalc() {
  if (Game.rooms.sim) {
    usedOnStart = 0; // This needs to be reset, but only in the sim.
    Game.cpu.getUsed = function getUsed() {
      return performance.now() - usedOnStart;
    };
  }
}

function getFilter() {
  return Memory.profiler.filter;
}

const functionBlackList = [
  'getUsed', // Let's avoid wrapping this... may lead to recursion issues and should be inexpensive.
  'constructor', // es6 class constructors need to be called with `new`
];

const commonProperties = ['length', 'name', 'arguments', 'caller', 'prototype'];

function wrapFunction(name, originalFunction) {
  if (originalFunction.__profiler) {
    // eslint-disable-next-line no-param-reassign
    originalFunction.__profiler = Profiler;
    return originalFunction;
  }

  function wrappedFunction() {
    const profiler = wrappedFunction.__profiler;
    if (profiler.isProfiling()) {
      const nameMatchesFilter = name === getFilter();
      const start = Game.cpu.getUsed();
      if (nameMatchesFilter) {
        depth++;
      }

      // FIX: Push onto the stack so any profiled function called from within
      // an un-profiled intermediary still sees the correct nearest profiled
      // ancestor as its parent, rather than a stale ancestor left over from
      // a previous call frame.
      parentStack.push(name);

      let result;
      if (this && this.constructor === wrappedFunction) {
        // eslint-disable-next-line new-cap
        result = new originalFunction(...arguments);
      } else {
        result = originalFunction.apply(this, arguments);
      }

      // Pop before recording — the parent is now the item below us on the stack,
      // and the grandparent is one further down.
      parentStack.pop();
      const currentParent = parentStack[parentStack.length - 1];
      const currentGrandparent = parentStack.length >= 2 ? parentStack[parentStack.length - 2] : null;

      if (depth > 0 || !getFilter()) {
        const end = Game.cpu.getUsed();
        profiler.record(name, end - start, currentParent, currentGrandparent);
      }
      if (nameMatchesFilter) {
        depth--;
      }
      return result;
    }

    if (this && this.constructor === wrappedFunction) {
      // eslint-disable-next-line new-cap
      return new originalFunction(...arguments);
    }
    return originalFunction.apply(this, arguments);
  }

  wrappedFunction.__profiler = Profiler;
  wrappedFunction.toString = () =>
    `// screeps-profiler wrapped function:\n${originalFunction.toString()}`;

  Object.getOwnPropertyNames(originalFunction).forEach(property => {
    if (!commonProperties.includes(property)) {
      wrappedFunction[property] = originalFunction[property];
    }
  });

  return wrappedFunction;
}

function hookUpPrototypes() {
  for (const { name, val } of Profiler.prototypes) {
    if (!val) {
      console.log(`skipping prototype hook ${name}, object appears to be missing`);
      continue;
    }
    profileObjectFunctions(val, name);
  }
}

function profileObjectFunctions(object, label) {
  if (!object || !(typeof object === 'object' || typeof object === 'function')) {
    throw new ProfilerError(`Asked to profile non-object ${object} for ${label}
      (${typeof object})`);
  }

  if (object.prototype) {
    profileObjectFunctions(object.prototype, label);
  }
  const objectToWrap = object;

  Object.getOwnPropertyNames(objectToWrap).forEach(functionName => {
    const extendedLabel = `${label}.${functionName}`;

    const isBlackListed = functionBlackList.indexOf(functionName) !== -1;
    if (isBlackListed) {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(objectToWrap, functionName);
    if (!descriptor) {
      return;
    }

    const hasAccessor = descriptor.get || descriptor.set;
    if (hasAccessor) {
      const configurable = descriptor.configurable;
      if (!configurable) {
        return;
      }

      const profileDescriptor = {};

      if (descriptor.get) {
        const extendedLabelGet = `${extendedLabel}:get`;
        profileDescriptor.get = profileFunction(descriptor.get, extendedLabelGet);
      }

      if (descriptor.set) {
        const extendedLabelSet = `${extendedLabel}:set`;
        profileDescriptor.set = profileFunction(descriptor.set, extendedLabelSet);
      }

      Object.defineProperty(objectToWrap, functionName, profileDescriptor);
      return;
    }

    const isFunction = typeof descriptor.value === 'function';
    if (!isFunction || !descriptor.writable) {
      return;
    }
    const originalFunction = objectToWrap[functionName];
    objectToWrap[functionName] = profileFunction(originalFunction, extendedLabel);
  });

  return objectToWrap;
}

function profileFunction(fn, functionName) {
  const fnName = functionName || fn.name;
  if (!fnName) {
    console.log('Couldn\'t find a function name for - ', fn);
    console.log('Will not profile this function.');
    return fn;
  }

  return wrapFunction(fnName, fn);
}

const Profiler = {
  // Split a string into chunks that each fit within maxChars, breaking only
  // on newline boundaries so individual lines are never truncated.
  notifyChunked(text, maxChars = 400) {
    const lines = text.split('\n');
    let chunk = '';
    for (const line of lines) {
      // +1 for the newline we'd add when joining
      if (chunk.length && chunk.length + 1 + line.length > maxChars) {
        Game.notify(chunk);
        chunk = line;
      } else {
        chunk = chunk.length ? chunk + '\n' + line : line;
      }
    }
    if (chunk.length) {
      Game.notify(chunk);
    }
  },

  printProfile() {
    console.log(Profiler.output());

    // Only perform these actions if the profiling session has reached its end tick.
    // This prevents memory from being cleared prematurely if you are using stream().
    if (Memory.profiler.disableTick === Game.time) {
      Profiler.notifyChunked(Profiler.output(Infinity));
      resetMemory();
    }
  },

  emailProfile() {
    Profiler.notifyChunked(Profiler.output(Infinity));
  },

  downloadCallgrind() {
    const id = `id${Math.random()}`;
    const shardId = Game.shard.name + (Game.shard.ptr ? '-ptr' : '');
    const filename = `callgrind.${shardId}.${Game.time}`;
    const data = Profiler.callgrind();
    if (!data) {
      console.log('No profile data to download');
      return;
    }
    /* eslint-disable */
    const download = `
    <script>
    var element = document.getElementById('${id}');
    if (!element) {
      element = document.createElement('a');
      element.setAttribute('id', '${id}');
      element.setAttribute('href', 'data:text/plain;charset=utf-8,${encodeURIComponent(data)}');
      element.setAttribute('download', '${filename}');

      element.style.display = 'none';
      document.body.appendChild(element);

      element.click();
    }
    </script>
    `;
    /* eslint-enable */
    console.log(
      download
      .split('\n')
      .map((s) => s.trim())
      .join('')
    );
  },

  callgrind() {
    if (!Memory.profiler || !Memory.profiler.enabledTick) return null;
    const elapsedTicks = Game.time - Memory.profiler.enabledTick + 1;
    Profiler.checkMapItem('(tick)');
    Memory.profiler.map['(tick)'].calls = elapsedTicks;
    Memory.profiler.map['(tick)'].time = Memory.profiler.totalTime;
    Profiler.checkMapItem('(root)');
    Memory.profiler.map['(root)'].calls = 1;
    Memory.profiler.map['(root)'].time = Memory.profiler.totalTime;
    Profiler.checkMapItem('(tick)', Memory.profiler.map['(root)'].subs);
    Memory.profiler.map['(root)'].subs['(tick)'].calls = elapsedTicks;
    Memory.profiler.map['(root)'].subs['(tick)'].time = Memory.profiler.totalTime;
    let body = `events: ns\nsummary: ${Math.round(
      Memory.profiler.totalTime * 1000000
      )}\n`;
    for (const fnName of Object.keys(Memory.profiler.map)) {
      const fn = Memory.profiler.map[fnName];
      let callsBody = '';
      let callsTime = 0;
      for (const callName of Object.keys(fn.subs)) {
        const call = fn.subs[callName];
        const ns = Math.round(call.time * 1000000);
        callsBody += `cfn=${callName}\ncalls=${call.calls} 1\n1 ${ns}\n`;
        callsTime += call.time;
      }
      body += `\nfn=${fnName}\n1 ${Math.round(
        (fn.time - callsTime) * 1000000
        )}\n${callsBody}`;
    }
    return body;
  },

  flat(passedOutputLengthLimit) {
    const outputLengthLimit = passedOutputLengthLimit || 1000;
    if (!Memory.profiler || !Memory.profiler.enabledTick) {
      return 'Profiler not active.';
    }

    const endTick = Math.min(Memory.profiler.disableTick || Game.time, Game.time);
    const startTick = Memory.profiler.enabledTick;
    const elapsedTicks = endTick - startTick + 1;
    const header = 'calls\t\tself\t\ttotal\t\tavg\t\tfunction';
    const footer = [
      `Avg: ${(Memory.profiler.totalTime / elapsedTicks).toFixed(2)}`,
      `Total: ${Memory.profiler.totalTime.toFixed(2)}`,
      `Ticks: ${elapsedTicks}`,
    ].join('\t');

    const lines = [header];
    let currentLength = header.length + 1 + footer.length;
    const allLines = Profiler.lines();
    let done = false;
    while (!done && allLines.length) {
      const line = allLines.shift();
      // each line added adds the line length plus a new line character.
      if (currentLength + line.length + 1 < outputLengthLimit) {
        lines.push(line);
        currentLength += line.length + 1;
      } else {
        done = true;
      }
    }
    lines.push(footer);
    return lines.join('\n');
  },

  lines() {
    const stats = Object.keys(Memory.profiler.map).map(functionName => {
      const functionCalls = Memory.profiler.map[functionName];
      // Calculate time spent in child/sub calls
      let childTime = 0;
      if (functionCalls.subs) {
        for (const subName of Object.keys(functionCalls.subs)) {
          childTime += functionCalls.subs[subName].time;
        }
      }
      const selfTime = functionCalls.time - childTime;
      return {
        name: functionName,
        calls: functionCalls.calls,
        totalTime: functionCalls.time,
        selfTime: selfTime,
        averageTime: functionCalls.time / functionCalls.calls,
      };
    }).sort((val1, val2) => {
      return val2.selfTime - val1.selfTime;
    });

    const lines = stats.map(data => {
      return [
        data.calls,
        data.selfTime.toFixed(1),
        data.totalTime.toFixed(1),
        data.averageTime.toFixed(3),
        data.name,
      ].join('\t\t');
    });

    return lines;
  },

  output(passedOutputLengthLimit, minTime) {
    const outputLengthLimit = passedOutputLengthLimit || 4000;
    const threshold = minTime || 1.0;
    if (!Memory.profiler || !Memory.profiler.enabledTick) {
      return 'Profiler not active.';
    }

    const endTick = Math.min(Memory.profiler.disableTick || Game.time, Game.time);
    const startTick = Memory.profiler.enabledTick;
    const elapsedTicks = endTick - startTick + 1;
    const header = 'calls\t\tself\t\ttotal\t\tcpu/tick\tcpu/t/call\tfunction';
    const footer = [
      `Avg: ${(Memory.profiler.totalTime / elapsedTicks).toFixed(2)}`,
      `Total: ${Memory.profiler.totalTime.toFixed(2)}`,
      `Ticks: ${elapsedTicks}`,
      `Tree threshold: ${threshold.toFixed(1)} CPU`,
    ].join('\t');

    const allLines = Profiler.treeLines(threshold, elapsedTicks);
    const lines = [header];
    let currentLength = header.length + 1 + footer.length;
    let done = false;
    while (!done && allLines.length) {
      const line = allLines.shift();
      if (currentLength + line.length + 1 < outputLengthLimit) {
        lines.push(line);
        currentLength += line.length + 1;
      } else {
        done = true;
      }
    }
    lines.push(footer);
    return lines.join('\n');
  },

  treeLines(threshold, elapsedTicks) {
    const map = Memory.profiler.map;
    const lines = [];
    const tickSubs = map['(tick)'] && map['(tick)'].subs ? map['(tick)'].subs : {};

    // Depth semantics:
    //   depth 0 — top-level function (self + total from global map)
    //   depth 1 — direct children, scoped via map[parent].subs[child]
    //   depth 2 — grandchildren, scoped via map[grandparent].subs[parent].subs[child]
    //             This is now fully path-scoped, so e.g. PowerCreep calls that
    //             arrive through a different top-level function won't bleed into
    //             an unrelated parent's subtree.
    const maxDepth = 2;

    // scopedSubs: when non-null, use this dict for the current node's children
    // instead of the node's global subs. Passed down from depth 1 → depth 2.
    const renderNode = (fnName, depth, scopedCalls, scopedTime, scopedSubs) => {
      const fnData = map[fnName];
      if (!fnData) return;

      const displayCalls = (scopedCalls != null) ? scopedCalls : fnData.calls;
      const displayTime = (scopedTime != null) ? scopedTime : fnData.time;

      // Self time only shown for root-level rows (depth 0).
      let selfStr = '';
      if (depth === 0) {
        let childTime = 0;
        if (fnData.subs) {
          for (const subName of Object.keys(fnData.subs)) {
            childTime += fnData.subs[subName].time;
          }
        }
        // Clamp self time to 0 so corrupted data doesn't show as negative.
        selfStr = Math.max(0, fnData.time - childTime).toFixed(1);
      }

      const prefix = depth === 0 ? '' : '  '.repeat(depth - 1) + '└ ';

      // For top-level rows, append cpu/tick and cpu/tick/call columns.
      const cpuPerTick = (depth === 0 && elapsedTicks)
        ? (displayTime / elapsedTicks).toFixed(2)
        : '';
      const cpuPerTickPerCall = (depth === 0 && elapsedTicks && displayCalls)
        ? (displayTime / elapsedTicks / displayCalls).toFixed(4)
        : '';

      lines.push([
        displayCalls,
        selfStr,
        displayTime.toFixed(1),
        cpuPerTick,
        cpuPerTickPerCall,
        prefix + fnName,
      ].join('\t\t'));

      if (depth < maxDepth) {
        // At depth 0→1: use the node's own global subs (already scoped to this
        // parent because record() writes parent.subs[child]).
        // At depth 1→2: use the 2-level scoped subs passed in from the parent,
        // i.e. map[grandparent].subs[parent].subs — fully path-scoped.
        const subsToUse = (scopedSubs != null) ? scopedSubs : fnData.subs;
        if (!subsToUse) return;

        const children = Object.keys(subsToUse).map(subName => ({
          name: subName,
          calls: subsToUse[subName].calls,
          time: Math.min(subsToUse[subName].time, displayTime),
          // Pass the 2-level subs down so depth-2 children are path-scoped.
          subs: subsToUse[subName].subs || null,
        })).sort((a, b) => b.time - a.time);

        for (const child of children) {
          if (child.time < Math.min(displayTime * 0.05, 0.5)) continue;
          renderNode(child.name, depth + 1, child.calls, child.time, child.subs);
        }
      }
    };

    const topLevel = Object.keys(tickSubs).map(fnName => ({
      name: fnName,
      time: tickSubs[fnName].time,
    })).sort((a, b) => b.time - a.time);

    for (const entry of topLevel) {
      if (entry.time < threshold) continue;
      renderNode(entry.name, 0, null, null);
    }

    return lines;
  },

  prototypes: [
    { name: 'ConstructionSite', val: ConstructionSite },
    { name: 'Creep', val: Creep },
    { name: 'Deposit', val: Deposit },
    { name: 'Flag', val: Flag },
    { name: 'Game', val: Game },
    { name: 'InterShardMemory', val: InterShardMemory },
    { name: 'Mineral', val: Mineral },
    { name: 'Nuke', val: Nuke },
    { name: 'OwnedStructure', val: OwnedStructure },
    { name: 'PathFinder', val: PathFinder },
    { name: 'PowerCreep', val: PowerCreep },
    { name: 'RawMemory', val: RawMemory },
    { name: 'Resource', val: Resource },
    { name: 'Room', val: Room },
    { name: 'RoomObject', val: RoomObject },
    { name: 'RoomPosition', val: RoomPosition },
    { name: 'RoomVisual', val: RoomVisual },
    { name: 'Ruin', val: Ruin },
    { name: 'Source', val: Source },
    { name: 'Store', val: Store },
    { name: 'Structure', val: Structure },
    { name: 'StructureContainer', val: StructureContainer },
    { name: 'StructureController', val: StructureController },
    { name: 'StructureExtension', val: StructureExtension },
    { name: 'StructureExtractor', val: StructureExtractor },
    { name: 'StructureFactory', val: StructureFactory },
    { name: 'StructureInvaderCore', val: StructureInvaderCore },
    { name: 'StructureKeeperLair', val: StructureKeeperLair },
    { name: 'StructureLab', val: StructureLab },
    { name: 'StructureLink', val: StructureLink },
    { name: 'StructureNuker', val: StructureNuker },
    { name: 'StructureObserver', val: StructureObserver },
    { name: 'StructurePortal', val: StructurePortal },
    { name: 'StructurePowerBank', val: StructurePowerBank },
    { name: 'StructurePowerSpawn', val: StructurePowerSpawn },
    { name: 'StructureRampart', val: StructureRampart },
    { name: 'StructureRoad', val: StructureRoad },
    { name: 'StructureSpawn', val: StructureSpawn },
    { name: 'StructureStorage', val: StructureStorage },
    { name: 'StructureTerminal', val: StructureTerminal },
    { name: 'StructureTower', val: StructureTower },
    { name: 'StructureWall', val: StructureWall },
    { name: 'Tombstone', val: Tombstone },
  ],

  checkMapItem(functionName, map = Memory.profiler.map) {
    if (!map[functionName]) {
      // eslint-disable-next-line no-param-reassign
      map[functionName] = {
        time: 0,
        calls: 0,
        subs: {},
      };
    }
  },

  record(functionName, time, parent, grandparent) {
    this.checkMapItem(functionName);
    Memory.profiler.map[functionName].calls++;
    Memory.profiler.map[functionName].time += time;
    if (parent) {
      this.checkMapItem(parent);
      this.checkMapItem(functionName, Memory.profiler.map[parent].subs);
      Memory.profiler.map[parent].subs[functionName].calls++;
      Memory.profiler.map[parent].subs[functionName].time += time;
      // Also record grandparent→parent→child so depth-2 rendering can use
      // a fully scoped subs dict instead of the global one.
      if (grandparent) {
        this.checkMapItem(grandparent);
        this.checkMapItem(parent, Memory.profiler.map[grandparent].subs);
        this.checkMapItem(functionName, Memory.profiler.map[grandparent].subs[parent].subs);
        Memory.profiler.map[grandparent].subs[parent].subs[functionName].calls++;
        Memory.profiler.map[grandparent].subs[parent].subs[functionName].time += time;
      }
    }
  },

  endTick() {
    if (Game.time >= Memory.profiler.enabledTick) {
      const cpuUsed = Game.cpu.getUsed();
      Memory.profiler.totalTime += cpuUsed;
      Profiler.report();
    }
  },

  report() {
    if (Profiler.shouldPrint()) {
      Profiler.printProfile();
    } else if (Profiler.shouldEmail()) {
      Profiler.emailProfile();
    } else if (Profiler.shouldCallgrind()) {
      Profiler.downloadCallgrind();
    }
  },

  isProfiling() {
    if (!enabled || !Memory.profiler) {
      return false;
    }
    return !Memory.profiler.disableTick || Game.time <= Memory.profiler.disableTick;
  },

  type() {
    return Memory.profiler.type;
  },

  shouldPrint() {
    const streaming = Profiler.type() === 'stream';
    const profiling = Profiler.type() === 'profile';
    const onEndingTick = Memory.profiler.disableTick === Game.time;
    return streaming || (profiling && onEndingTick);
  },

  shouldEmail() {
    return Profiler.type() === 'email' && Memory.profiler.disableTick === Game.time;
  },

  shouldCallgrind() {
    return (
      Profiler.type() === 'callgrind' &&
      Memory.profiler.disableTick === Game.time
    );
  },
};

module.exports = {
  wrap(callback) {
    if (enabled) {
      setupProfiler();
    }

    if (Profiler.isProfiling()) {
      usedOnStart = Game.cpu.getUsed();

      // Commented lines are part of an on going experiment to keep the profiler
      // performant, and measure certain types of overhead.

      // var callbackStart = Game.cpu.getUsed();
      const returnVal = callback();
      // var callbackEnd = Game.cpu.getUsed();
      Profiler.endTick();
      // var end = Game.cpu.getUsed();

      // var profilerTime = (end - start) - (callbackEnd - callbackStart);
      // var callbackTime = callbackEnd - callbackStart;
      // var unaccounted = end - profilerTime - callbackTime;
      // console.log('total-', end, 'profiler-', profilerTime, 'callbacktime-',
      // callbackTime, 'start-', start, 'unaccounted', unaccounted);
      return returnVal;
    }

    return callback();
  },

  enable() {
    enabled = true;
    hookUpPrototypes();
  },

  output: Profiler.output,
  flat: Profiler.flat,
  callgrind: Profiler.callgrind,

  registerObject: profileObjectFunctions,
  registerFN: profileFunction,
  registerClass: profileObjectFunctions,

  Error: ProfilerError,
};