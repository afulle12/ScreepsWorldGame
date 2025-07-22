// Toggle logging for supplier task table here:
const SUPPLIER_LOGGING_ENABLED = false;
const SUPPLIER_CONTAINER_CATEGORY_LOGGING = false;

// Toggle to enable or disable the supplier role
const SUPPLIER_ENABLED = true;  // Set to false to disable

// --- CONFIGURABLE HYBRID CONTAINER RANGES ---
const HYBRID_MIN = 750;
const HYBRID_MAX = 1250;

const roleSupplier = {
  /** @param {Creep} creep **/
  run: function(creep) {
    if (!SUPPLIER_ENABLED) {
      if (Game.time % 5 === 0) {
        creep.say('Supplier disabled');
      }
      return;  // Do not execute further logic
    }

    // --- SINGLE-TICK CACHE INITIALIZATION ---
    // This replaces the expensive Memory-based cache with a fast global cache.
    // The global object is cleared each tick, making it ideal for this purpose.
    // For best practice, initialize global.cache once in your main.js loop.
    if (!global.cache) {
      global.cache = {};
    }
    if (!global.cache.containerLabels) {
      global.cache.containerLabels = {};
    }
    if (!global.cache.supplierTasks) {
      global.cache.supplierTasks = {};
    }

    // --- ANTI-STUCK & REROUTE LOGIC ---
    if (creep.memory.lastPos && creep.pos.isEqualTo(creep.memory.lastPos.x, creep.memory.lastPos.y)) {
      creep.memory.stuckCount = (creep.memory.stuckCount || 0) + 1;
    } else {
      // Successfully moved this tick
      if (creep.memory.rerouting) {
        // Cleared the blockage, stop avoiding creeps
        delete creep.memory.rerouting;
      }
      creep.memory.stuckCount = 0;
    }
    creep.memory.lastPos = { x: creep.pos.x, y: creep.pos.y };

    // Decide whether we're in "reroute" mode (treat creeps as permanent obstacles)
    let moveOpts = {
      reusePath: creep.memory.rerouting ? 0 : 5,
      ignoreCreeps: !creep.memory.rerouting
    };

    if (creep.memory.stuckCount >= 3) {
      // We've been stuck: enter reroute mode
      creep.memory.rerouting = true;
      creep.say('🔄 reroute');
      creep.memory.stuckCount = 0;
      // moveOpts will automatically use reusePath=0 and ignoreCreeps=false
    }

    // --- (MODIFIED) PRIORITY MINERALS DROP-OFF LOGIC ---
    // This logic block ensures that if a supplier is carrying any non-energy resource,
    // its absolute top priority is to deposit that resource into the terminal or storage.
    // It will not perform any other tasks until its mineral cargo is empty.
    let mineralType = null;
    for (const resourceType in creep.store) {
        if (resourceType !== RESOURCE_ENERGY && creep.store[resourceType] > 0) {
            mineralType = resourceType;
            break;
        }
    }

    if (mineralType) {
        // Creep is carrying a mineral. Find the nearest storage or terminal with space.
        const depositTarget = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: (s) => (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL) &&
                             s.store.getFreeCapacity(mineralType) > 0
        });

        if (depositTarget) {
            creep.say('💎 deposit');
            const transferResult = creep.transfer(depositTarget, mineralType);
            if (transferResult === ERR_NOT_IN_RANGE) {
                // Move towards the target if not in range.
                creep.moveTo(depositTarget, { ...moveOpts, visualizePathStyle: { stroke: '#cc00cc' } });
            }
            // Whether moving or transferring, this is the only action for this tick.
            return;
        } else {
            // If no deposit target is available (e.g., storage/terminal full), wait.
            creep.say('⚠️ full!');
            // By returning here, we still prevent other tasks from running.
            return;
        }
    }

    // --- CONSTANTS & HELPERS ---
    const TASK_PRIORITIES = [
      { type: 'spawn', filter: s => s.structureType === STRUCTURE_SPAWN && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
      { type: 'extension', filter: s => s.structureType === STRUCTURE_EXTENSION && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
      { type: 'tower', filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && (s.store[RESOURCE_ENERGY] / s.store.getCapacity(RESOURCE_ENERGY)) < 0.75 },
      { type: 'link', filter: s => s.structureType === STRUCTURE_LINK && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 },
      { type: 'storage', filter: s => s.structureType === STRUCTURE_STORAGE && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 }
    ];

    function getTaskPriorityValue(taskType) {
      switch (taskType) {
        case 'spawn': return 1;
        case 'extension': return 2;
        case 'tower': return 3;
        case 'link_fill': return 3.4;
        case 'link_drain': return 3.4;
        case 'link': return 3.5;
        case 'container_balance': return 3.6;
        case 'container_empty': return 4;
        case 'materials_empty': return 4.5;
        case 'materials_drain_energy': return 4.5;
        case 'storage': return 5;
        case 'container_drain': return 6;
        default: return 7;
      }
    }

    // --- CONTAINER LABELING (caching per tick on global) ---
    if (!global.cache.containerLabels[creep.room.name] || global.cache.containerLabels[creep.room.name].tick !== Game.time) {
      const containers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
      const sources = creep.room.find(FIND_SOURCES);
      const spawns = creep.room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
      const extractors = creep.room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTRACTOR });
      const controller = creep.room.controller;

      let labels = {};
      let donors = [], hybrids = [], recipients = [], materials = [];

      for (let c of containers) {
        let isMaterialsContainer = extractors.some(ex => ex.pos.getRangeTo(c.pos) === 1);
        if (isMaterialsContainer) {
          labels[c.id] = 'materials';
          materials.push(c);
        } else {
          let isDonor = sources.some(src => src.pos.getRangeTo(c.pos) <= 4);
          let isRecipient = (controller && controller.pos.getRangeTo(c.pos) <= 5)
                           || spawns.some(sp => sp.pos.getRangeTo(c.pos) <= 5);
          let label = (!isDonor && isRecipient) ? 'recipient'
                    : (isDonor && !isRecipient) ? 'donor'
                    : 'hybrid';
          labels[c.id] = label;
          if (label === 'donor') donors.push(c);
          if (label === 'hybrid') hybrids.push(c);
          if (label === 'recipient') recipients.push(c);
        }
      }
      global.cache.containerLabels[creep.room.name] = { tick: Game.time, labels };

      if (SUPPLIER_CONTAINER_CATEGORY_LOGGING) {
        let log = `\n🏷️ Container Categories for room ${creep.room.name} (Tick ${Game.time}):\n`;
        log += `Donors: ${donors.length ? donors.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
        log += `Hybrids: ${hybrids.length ? hybrids.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
        log += `Recipients: ${recipients.length ? recipients.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
        log += `Materials: ${materials.length ? materials.map(c => c.id.slice(-6)).join(', ') : 'none'}\n`;
        console.log(log);
      }
    }
    const containerLabels = global.cache.containerLabels[creep.room.name].labels;

    // --- COUNT ASSIGNED SUPPLIERS ---
    const allRoomSuppliers = _.filter(Game.creeps, c => c.memory.role === 'supplier' && c.room.name === creep.room.name);
    let assignedCounts = {};
    for (let sCreep of allRoomSuppliers) {
      if (sCreep.memory.assignment && sCreep.memory.assignment.taskId) {
        assignedCounts[sCreep.memory.assignment.taskId] = (assignedCounts[sCreep.memory.assignment.taskId] || 0) + 1;
      }
    }

    // --- TASK DISCOVERY (cached per tick on global) ---
    if (!global.cache.supplierTasks[creep.room.name] || global.cache.supplierTasks[creep.room.name].tick !== Game.time) {
      let tasks = [];

      // Basic fill tasks
      for (let p = 0; p < TASK_PRIORITIES.length; p++) {
        if (TASK_PRIORITIES[p].type === 'link') continue;
        let structs = creep.room.find(FIND_STRUCTURES, { filter: TASK_PRIORITIES[p].filter });
        for (let s of structs) {
          let need = s.store.getFreeCapacity(RESOURCE_ENERGY);
          if (need > 0) {
            tasks.push({ id: s.id, type: TASK_PRIORITIES[p].type, pos: s.pos, need, assigned: 0, maxAssign: 1 });
          }
        }
        if (TASK_PRIORITIES[p].type === 'tower' && tasks.length > 0) break;
      }

      // Link logic
      if (creep.room.storage) {
        const storageLinks = creep.room.find(FIND_STRUCTURES, {
          filter: s => s.structureType === STRUCTURE_LINK && s.pos.inRangeTo(creep.room.storage.pos, 3)
        });
        if (storageLinks.length > 0) {
          const LINK_FILL_THRESHOLD = 150, LINK_DRAIN_THRESHOLD = 475;
          for (let link of storageLinks) {
            // Skip any link within 2 squares of the room controller
            if (creep.room.controller && link.pos.getRangeTo(creep.room.controller.pos) <= 2) continue;

            const linkEnergy = link.store[RESOURCE_ENERGY];
            if (linkEnergy < LINK_FILL_THRESHOLD && creep.room.storage.store[RESOURCE_ENERGY] > 0) {
              const amount = Math.min(
                LINK_DRAIN_THRESHOLD - linkEnergy,
                creep.room.storage.store[RESOURCE_ENERGY],
                link.store.getFreeCapacity(RESOURCE_ENERGY)
              );
              if (amount > 0) {
                tasks.push({
                  id: creep.room.storage.id,
                  type: 'link_fill',
                  pos: creep.room.storage.pos,
                  need: amount,
                  assigned: 0,
                  maxAssign: 1,
                  transferTargetId: link.id,
                  transferTargetPos: link.pos
                });
              }
            } else if (linkEnergy > LINK_DRAIN_THRESHOLD) {
              const amount = Math.min(
                linkEnergy - LINK_FILL_THRESHOLD,
                creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY)
              );
              if (amount > 0) {
                tasks.push({
                  id: link.id,
                  type: 'link_drain',
                  pos: link.pos,
                  need: amount,
                  assigned: 0,
                  maxAssign: 1,
                  transferTargetId: creep.room.storage.id,
                  transferTargetPos: creep.room.storage.pos
                });
              }
            }
          }
        }
      } else {
        const allLinks = creep.room.find(FIND_STRUCTURES, {
          filter: s => s.structureType === STRUCTURE_LINK && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });
        for (let link of allLinks) {
          // Skip any link within 2 squares of the room controller
          if (creep.room.controller && link.pos.getRangeTo(creep.room.controller.pos) <= 2) continue;

          tasks.push({
            id: link.id,
            type: 'link',
            pos: link.pos,
            need: link.store.getFreeCapacity(RESOURCE_ENERGY),
            assigned: 0,
            maxAssign: 1
          });
        }
      }

      // Materials container logic...
      const containers = creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
      let donors = [], hybrids = [], recipients = [], materials = [];

      for (let c of containers) {
        switch (containerLabels[c.id]) {
          case 'materials':
            materials.push(c);
            // Drain energy
            if (c.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
              let drainTarget = creep.room.storage || creep.pos.findClosestByRange(FIND_STRUCTURES, {
                filter: s => (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_TOWER)
                  && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && containerLabels[s.id] !== 'materials'
              });
              if (drainTarget && drainTarget.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                tasks.push({
                  id: c.id,
                  type: 'materials_drain_energy',
                  pos: c.pos,
                  need: c.store.getUsedCapacity(RESOURCE_ENERGY),
                  assigned: 0,
                  maxAssign: 1,
                  transferTargetId: drainTarget.id,
                  transferTargetPos: drainTarget.pos
                });
              }
            }
            // Empty minerals
            let totalMinerals = _.sum(Object.entries(c.store)
              .filter(([res, amt]) => res !== RESOURCE_ENERGY)
              .map(([, amt]) => amt));
            if (totalMinerals >= 200) {
              let emptyTarget = creep.room.storage || creep.room.terminal
                || creep.pos.findClosestByRange(FIND_STRUCTURES, {
                  filter: s => s.structureType === STRUCTURE_CONTAINER
                    && containerLabels[s.id] !== 'materials' && s.store.getFreeCapacity() > 0
                });
              if (emptyTarget && emptyTarget.store.getFreeCapacity() > 0) {
                tasks.push({
                  id: c.id,
                  type: 'materials_empty',
                  pos: c.pos,
                  need: totalMinerals,
                  assigned: 0,
                  maxAssign: 1,
                  transferTargetId: emptyTarget.id,
                  transferTargetPos: emptyTarget.pos
                });
              }
            }
            break;
          case 'donor':     donors.push(c); break;
          case 'hybrid':    hybrids.push(c); break;
          case 'recipient': recipients.push(c); break;
          default: break;
        }
      }

      // Donor → Hybrid/Recipient/Storage/Tower
      for (let donor of donors) {
        let donorEnergy = donor.store.getUsedCapacity(RESOURCE_ENERGY);
        if (donorEnergy <= 0) continue;
        let targets = [];
        hybrids.forEach(h => {
          let energy = h.store.getUsedCapacity(RESOURCE_ENERGY);
          if (energy < HYBRID_MIN) {
            targets.push({
              id: h.id, type: 'hybrid', obj: h,
              need: Math.min(HYBRID_MIN - energy, donorEnergy, h.store.getFreeCapacity(RESOURCE_ENERGY))
            });
          }
        });
        recipients.forEach(r => {
          let energy = r.store.getUsedCapacity(RESOURCE_ENERGY);
          let cap = r.store.getCapacity(RESOURCE_ENERGY);
          if (energy < cap) {
            targets.push({
              id: r.id, type: 'recipient', obj: r,
              need: Math.min(cap - energy, donorEnergy, r.store.getFreeCapacity(RESOURCE_ENERGY))
            });
          }
        });
        if (!targets.length && creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          targets.push({
            id: creep.room.storage.id, type: 'storage', obj: creep.room.storage,
            need: Math.min(donorEnergy, creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY))
          });
        }
        if (!targets.length && !creep.room.storage) {
          const towers = creep.room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
          });
          if (towers.length) {
            let t = donor.pos.findClosestByRange(towers);
            targets.push({
              id: t.id, type: 'container_drain', obj: t,
              need: Math.min(donorEnergy, t.store.getFreeCapacity(RESOURCE_ENERGY))
            });
          }
        }
        targets.forEach(t => {
          tasks.push({
            id: donor.id,
            type: t.type === 'container_drain' ? 'container_drain' : 'container_balance',
            pos: donor.pos,
            need: t.need,
            assigned: 0,
            maxAssign: t.type === 'container_balance' ? 5 : 1,
            transferTargetId: t.id,
            transferTargetPos: t.obj.pos
          });
        });
      }

      // Hybrid overflow/underflow
      hybrids.forEach(hybrid => {
        let energy = hybrid.store.getUsedCapacity(RESOURCE_ENERGY);
        if (energy > HYBRID_MAX) {
          let excess = energy - HYBRID_MAX;
          let targets = [];
          recipients.forEach(r => {
            let rEnergy = r.store.getUsedCapacity(RESOURCE_ENERGY);
            let cap = r.store.getCapacity(RESOURCE_ENERGY);
            if (rEnergy < cap) {
              targets.push({
                id: r.id, type: 'recipient', obj: r,
                need: Math.min(cap - rEnergy, excess, r.store.getFreeCapacity(RESOURCE_ENERGY))
              });
            }
          });
          hybrids.forEach(oh => {
            if (oh.id === hybrid.id) return;
            let oe = oh.store.getUsedCapacity(RESOURCE_ENERGY);
            if (oe < HYBRID_MIN) {
              targets.push({
                id: oh.id, type: 'hybrid', obj: oh,
                need: Math.min(HYBRID_MIN - oe, excess, oh.store.getFreeCapacity(RESOURCE_ENERGY))
              });
            }
          });
          if (!targets.length && creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            targets.push({
              id: creep.room.storage.id, type: 'storage', obj: creep.room.storage,
              need: Math.min(excess, creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY))
            });
          }
          if (!targets.length && !creep.room.storage) {
            const towers = creep.room.find(FIND_STRUCTURES, {
              filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            });
            if (towers.length) {
              let t = hybrid.pos.findClosestByRange(towers);
              targets.push({
                id: t.id, type: 'container_drain', obj: t,
                need: Math.min(excess, t.store.getFreeCapacity(RESOURCE_ENERGY))
              });
            }
          }
          targets.forEach(t => {
            tasks.push({
              id: hybrid.id,
              type: t.type === 'container_drain' ? 'container_drain' : 'container_balance',
              pos: hybrid.pos,
              need: t.need,
              assigned: 0,
              maxAssign: 1,
              transferTargetId: t.id,
              transferTargetPos: t.obj.pos
            });
          });
        } else if (energy < HYBRID_MIN && creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
          let amount = Math.min(
            HYBRID_MIN - energy,
            hybrid.store.getFreeCapacity(RESOURCE_ENERGY),
            creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY)
          );
          if (amount > 0) {
            tasks.push({
              id: creep.room.storage.id,
              type: 'container_balance',
              pos: creep.room.storage.pos,
              need: amount,
              assigned: 0,
              maxAssign: 1,
              transferTargetId: hybrid.id,
              transferTargetPos: hybrid.pos
            });
          }
        }
      });

      // Recipients when no donor/hybrid → storage/hybrids
      let donorOrHybridHasEnergy = donors.some(d => d.store.getUsedCapacity(RESOURCE_ENERGY) > 0)
        || hybrids.some(h => h.store.getUsedCapacity(RESOURCE_ENERGY) > HYBRID_MIN);
      recipients.forEach(r => {
        let rEnergy = r.store.getUsedCapacity(RESOURCE_ENERGY);
        let cap = r.store.getCapacity(RESOURCE_ENERGY);
        if (rEnergy < cap) {
          let sources = [];
          if (!donorOrHybridHasEnergy) {
            if (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
              sources.push({
                id: creep.room.storage.id,
                type: 'storage',
                obj: creep.room.storage,
                available: creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY)
              });
            }
            hybrids.forEach(h => {
              let he = h.store.getUsedCapacity(RESOURCE_ENERGY);
              if (he > HYBRID_MIN) {
                sources.push({
                  id: h.id,
                  type: 'hybrid',
                  obj: h,
                  available: he - HYBRID_MIN
                });
              }
            });
          }
          sources.forEach(src => {
            let amt = Math.min(cap - rEnergy, src.available, r.store.getFreeCapacity(RESOURCE_ENERGY));
            if (amt > 0) {
              tasks.push({
                id: src.id,
                type: 'container_balance',
                pos: src.obj.pos,
                need: amt,
                assigned: 0,
                maxAssign: 1,
                transferTargetId: r.id,
                transferTargetPos: r.pos
              });
            }
          });
        }
      });

      // Any other container with energy → storage
      containers.forEach(c => {
        if (!['donor','hybrid','recipient','materials'].includes(containerLabels[c.id])) {
          let amt = c.store.getUsedCapacity(RESOURCE_ENERGY);
          if (amt > 0 && creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            tasks.push({
              id: c.id,
              type: 'container_empty',
              pos: c.pos,
              need: amt,
              assigned: 0,
              maxAssign: 1,
              targetId: creep.room.storage.id
            });
          }
        }
      });

      tasks = _.sortBy(tasks, t => getTaskPriorityValue(t.type));
      global.cache.supplierTasks[creep.room.name] = { tick: Game.time, tasks };
    }

    const tasks = global.cache.supplierTasks[creep.room.name].tasks;

    // --- REFRACTOR: VALIDATE OR PICK ASSIGNMENT ---
    // 1. Validate current assignment
    if (creep.memory.assignment) {
      let a = creep.memory.assignment;
      let exists = tasks.some(t => t.id === a.taskId && t.type === a.type);
      let srcObj = Game.getObjectById(a.taskId);
      let dstObj = a.transferTargetId ? Game.getObjectById(a.transferTargetId) : srcObj;
      if (!exists || !srcObj || !dstObj
        || (dstObj.store && dstObj.store.getFreeCapacity(RESOURCE_ENERGY) === 0
          && !['link_drain','materials_drain_energy','materials_empty'].includes(a.type))) {
        creep.memory.assignment = null;
      }
    }

    // 2. Pick new assignment if needed
    if (!creep.memory.assignment) {
      let potential = [];
      let bestVal = Infinity;
      for (let t of tasks) {
        if ((assignedCounts[t.id] || 0) >= t.maxAssign) continue;
        let val = getTaskPriorityValue(t.type);
        if (val < bestVal) {
          bestVal = val;
          potential = [t];
        } else if (val === bestVal) {
          potential.push(t);
        }
      }
      if (potential.length) {
        let mapped = potential.map(t => ({
          ...t,
          pos: new RoomPosition(t.pos.x, t.pos.y, creep.room.name)
        }));
        let best = creep.pos.findClosestByRange(mapped);
        if (best) {
          creep.memory.assignment = {
            taskId: best.id,
            type: best.type,
            transferTargetId: best.transferTargetId,
            amount: best.need
          };
          let isWithdraw = best.type.startsWith('container') || best.type === 'link_drain' || best.type.startsWith('materials');
          creep.memory.state = isWithdraw || creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0
            ? 'fetching' : 'delivering';
        }
      }
    }

    // 3. Execute action
    if (creep.memory.assignment) {
      if (creep.memory.state === 'fetching' && creep.store.getFreeCapacity() === 0) {
        creep.memory.state = 'delivering';
      }
      if (creep.memory.state === 'delivering' && creep.store.getUsedCapacity() === 0) {
        creep.memory.assignment = null;
        return;
      }

      if (creep.memory.state === 'fetching') {
        creep.say('🔄 fetch');
        let a = creep.memory.assignment;
        let source = a.type.startsWith('container') || a.type === 'link_drain' || a.type.startsWith('materials')
          ? Game.getObjectById(a.taskId)
          : creep.pos.findClosestByRange(FIND_STRUCTURES, {
              filter: s => (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_CONTAINER)
                && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0
            });
        if (source) {
          let resType = RESOURCE_ENERGY;
          let amt;
          if (a.type === 'materials_empty') {
            for (let r in source.store) {
              if (r !== RESOURCE_ENERGY) {
                resType = r;
                break;
              }
            }
          } else if (a.type === 'link_drain' && a.amount) {
            amt = Math.min(a.amount, creep.store.getFreeCapacity(RESOURCE_ENERGY));
          } else if (a.type === 'materials_drain_energy') {
            resType = RESOURCE_ENERGY;
          }
          if (creep.withdraw(source, resType, amt) === ERR_NOT_IN_RANGE) {
            creep.moveTo(source, { ...moveOpts, visualizePathStyle: { stroke: '#ffaa00' } });
          }
        }
      } else if (creep.memory.state === 'delivering') {
        creep.say('🚚 deliver');
        let a = creep.memory.assignment;
        let target = a.transferTargetId ? Game.getObjectById(a.transferTargetId) : Game.getObjectById(a.taskId);
        if (target) {
          let resType = RESOURCE_ENERGY;
          let amt;
          if (a.type === 'materials_empty') {
            for (let r in creep.store) {
              if (r !== RESOURCE_ENERGY && creep.store[r] > 0) {
                resType = r;
                break;
              }
            }
          } else if (a.type === 'link_fill' && a.amount) {
            amt = Math.min(a.amount, creep.store.getUsedCapacity(RESOURCE_ENERGY));
          }
          let res = creep.transfer(target, resType, amt);
          if (res === ERR_NOT_IN_RANGE) {
            creep.moveTo(target, { ...moveOpts, visualizePathStyle: { stroke: '#ffffff' } });
          } else if (res === OK || res === ERR_FULL) {
            creep.memory.assignment = null;
          }
        } else {
          creep.memory.assignment = null;
        }
      }
    }

    // --- LOGGING (every 5 ticks, first supplier only) ---
    if (SUPPLIER_LOGGING_ENABLED && allRoomSuppliers[0] === creep && Game.time % 5 === 0) {
      let assignmentMap = {};
      allRoomSuppliers.forEach(s => {
        if (s.memory.assignment && s.memory.assignment.taskId) {
          let id = s.memory.assignment.taskId;
          assignmentMap[id] = assignmentMap[id] || [];
          assignmentMap[id].push(s.name.slice(-4));
        }
      });
      let rows = [];
      tasks.forEach(t => {
        let supNames = assignmentMap[t.id] || [];
        let source = 'auto', dest = '---';
        if (['container_balance','link_fill','link_drain','materials_drain_energy','materials_empty'].includes(t.type)) {
          let srcObj = Game.getObjectById(t.id);
          let dstObj = Game.getObjectById(t.transferTargetId);
          source = srcObj ? srcObj.structureType.substring(0,4) + ':' + t.id.slice(-4) : 'ERR';
          dest   = dstObj ? dstObj.structureType.substring(0,4) + ':' + t.transferTargetId.slice(-4) : 'ERR';
        } else if (t.sourceId) {
          let srcObj = Game.getObjectById(t.sourceId);
          source = srcObj
            ? (srcObj.structureType === STRUCTURE_STORAGE ? 'stor' : 'cont:' + t.sourceId.slice(-4))
            : 'ERR';
          dest = t.id.slice(-4);
        } else if (['container_empty','container_drain'].includes(t.type)) {
          source = 'cont:' + t.id.slice(-4);
          if (t.targetId) {
            let tgt = Game.getObjectById(t.targetId);
            if (tgt) {
              dest = (tgt.structureType === STRUCTURE_STORAGE ? 'stor'
                   : tgt.structureType === STRUCTURE_TOWER    ? 'towr:' + t.targetId.slice(-4)
                   : 'cont:' + t.targetId.slice(-4));
            } else dest = 'ERR';
          }
        } else dest = t.id.slice(-4);

        rows.push({
          type: t.type.padEnd(20),
          id: t.id.slice(-6).padEnd(6),
          pos: `${t.pos.x},${t.pos.y}`.padEnd(4),
          need: t.need.toString().padEnd(4),
          assigned: `${supNames.length}/${t.maxAssign}`.padEnd(7),
          suppliers: (supNames.join(',') || 'none').padEnd(19),
          source: source.padEnd(9),
          destination: dest.padEnd(11)
        });
      });
      let idle = allRoomSuppliers.filter(s => !s.memory.assignment).map(s => s.name.slice(-4));
      if (idle.length) {
        rows.push({
          type: 'IDLE'.padEnd(20),
          id: '------',
          pos: '---',
          need: '---',
          assigned: `${idle.length}/∞`.padEnd(7),
          suppliers: idle.join(',').padEnd(19),
          source: 'none'.padEnd(9),
          destination: '---'.padEnd(11)
        });
      }
      if (rows.length) {
        console.log(`\n🚚 SUPPLIER TASKS - ${creep.room.name} (Tick ${Game.time})`);
        console.log('┌──────────────────────┬────────┬──────┬──────┬─────────┬─────────────────────┬───────────┬─────────────┐');
        console.log('│ Type                 │ ID     │ Pos  │ Need │ Assign  │ Suppliers           │ Source    │ Destination │');
        console.log('├──────────────────────┼────────┼──────┼──────┼─────────┼─────────────────────┼───────────┴─────────────┤');
        rows.forEach(r => {
          console.log(`│ ${r.type} │ ${r.id} │ ${r.pos} │ ${r.need} │ ${r.assigned} │ ${r.suppliers} │ ${r.source} │ ${r.destination} │`);
        });
        console.log('└──────────────────────┴────────┴──────┴──────┴─────────┴─────────────────────┴───────────┴─────────────┘');
      } else {
        console.log(`🚚 ${creep.room.name}: No supplier tasks available`);
      }
    }
  }
};

module.exports = roleSupplier;
