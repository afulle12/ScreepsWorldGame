const DEBUG = false; // Set to false to disable console logging

const WALL_REPAIR_THRESHOLD = 100000;
const WORK_AREA_RANGE = 10; // Builders will stick to work within this range
const MAX_STUCK_ATTEMPTS = 5; // Max attempts before giving up on a target

const roleBuilder = {
    run: function(creep) {
        // Update working state based on energy level
        if(creep.memory.building && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.building = false;
            creep.say('🔄 harvest');
            if (DEBUG) console.log(`Builder ${creep.name}: Switching to harvest mode - out of energy`);
            delete creep.memory.repairingWallId;
            delete creep.memory.buildingTargetId;
            delete creep.memory.workArea;
            delete creep.memory.targetAttempts; // Clear attempt counter
        }
        if(!creep.memory.building && creep.store.getFreeCapacity() === 0) {
            creep.memory.building = true;
            creep.say('🚧 build');
            if (DEBUG) console.log(`Builder ${creep.name}: Switching to building mode - energy full`);
            delete creep.memory.targetAttempts; // Clear attempt counter
        }

        // Building mode - find something useful to do
        if(creep.memory.building) {
            if (DEBUG) console.log(`Builder ${creep.name}: In building mode, looking for tasks...`);

            // Priority 1: Find construction sites
            const constructionSites = this.findConstructionSites(creep);
            if(constructionSites.length > 0) {
                if (DEBUG) console.log(`Builder ${creep.name}: Found ${constructionSites.length} construction sites`);
                let target = null;

                // Check if we already have a valid target
                if(creep.memory.buildingTargetId) {
                    target = Game.getObjectById(creep.memory.buildingTargetId);
                    if(!target) {
                        if (DEBUG) console.log(`Builder ${creep.name}: Previous target no longer exists, finding new target`);
                        delete creep.memory.buildingTargetId;
                        delete creep.memory.targetAttempts;
                        target = null;
                    } else {
                        // Check if we've been stuck on this target too long
                        if(this.isStuckOnTarget(creep, 'buildingTargetId')) {
                            if (DEBUG) console.log(`Builder ${creep.name}: Stuck on construction target, finding new target`);
                            delete creep.memory.buildingTargetId;
                            delete creep.memory.targetAttempts;
                            target = null;
                        }
                    }
                }

                // If we don't have a target, find a new one
                if(!target) {
                    target = this.findReachableConstructionSite(creep, constructionSites);
                    if(target) {
                        creep.memory.buildingTargetId = target.id;
                        delete creep.memory.targetAttempts; // Reset attempts for new target
                        // Set work area based on this target
                        creep.memory.workArea = {
                            x: target.pos.x,
                            y: target.pos.y,
                            roomName: target.pos.roomName
                        };
                        if (DEBUG) console.log(`Builder ${creep.name}: Found reachable construction site at ${target.pos}, setting work area`);
                    }
                }

                if(target) {
                    if (DEBUG) console.log(`Builder ${creep.name}: Building ${target.structureType} at ${target.pos}`);
                    const buildResult = creep.build(target);
                    if(buildResult == ERR_NOT_IN_RANGE) {
                        const moveResult = creep.moveTo(target, {
                            visualizePathStyle: {stroke: '#ffffff'},
                            reusePath: 5 // Shorter reuse path for better responsiveness
                        });

                        // Track if movement failed
                        if(moveResult === ERR_NO_PATH) {
                            if (DEBUG) console.log(`Builder ${creep.name}: No path to construction site, abandoning target`);
                            delete creep.memory.buildingTargetId;
                            delete creep.memory.targetAttempts;
                            return; // Try again next tick
                        } else if(moveResult === OK) {
                            // Movement succeeded, increment attempt counter
                            this.incrementTargetAttempts(creep, 'buildingTargetId');
                        }

                        creep.say('🚧');
                    } else if(buildResult == OK) {
                        // Successfully building, reset attempts
                        delete creep.memory.targetAttempts;
                        creep.say('🚧');
                    } else if(buildResult === ERR_INVALID_TARGET) {
                        if (DEBUG) console.log(`Builder ${creep.name}: Invalid construction target, finding new target`);
                        delete creep.memory.buildingTargetId;
                        delete creep.memory.targetAttempts;
                        return;
                    }
                    delete creep.memory.repairingWallId;
                    return;
                } else {
                    if (DEBUG) console.log(`Builder ${creep.name}: No reachable construction sites found`);
                }
            }

            delete creep.memory.buildingTargetId;

            // Get the current working room
            const workingRoom = this.getWorkingRoom(creep);

            // Only work in owned rooms
            if (!workingRoom) {
                if (DEBUG) console.log(`Builder ${creep.name}: No owned room to work in, idling`);
                return;
            }

            // Priority 2: Repair damaged ramparts (prioritize work area)
            const allDamagedRamparts = workingRoom.find(FIND_STRUCTURES, {
                filter: (structure) => 
                    structure.structureType === STRUCTURE_RAMPART &&
                    structure.hits < WALL_REPAIR_THRESHOLD
            });
            if(allDamagedRamparts.length > 0) {
                if (DEBUG) console.log(`Builder ${creep.name}: Repairing ramparts - found ${allDamagedRamparts.length} damaged ramparts`);
                const target = this.findReachableRepairTarget(creep, allDamagedRamparts);
                if(target) {
                    const repairResult = creep.repair(target);
                    if(repairResult == ERR_NOT_IN_RANGE) {
                        const moveResult = creep.moveTo(target, {
                            visualizePathStyle: {stroke: '#b7b7b7'},
                            reusePath: 5
                        });
                        if(moveResult === ERR_NO_PATH) {
                            if (DEBUG) console.log(`Builder ${creep.name}: No path to rampart, skipping`);
                            return;
                        }
                        creep.say('🛡️');
                    } else if(repairResult == OK) {
                        creep.say('🛡️');
                    }
                    delete creep.memory.repairingWallId;
                    return;
                }
            }

            // Priority 3: Repair damaged containers
            const allDamagedContainers = workingRoom.find(FIND_STRUCTURES, {
                filter: (structure) => structure.structureType === STRUCTURE_CONTAINER && structure.hits < structure.hitsMax * 0.75
            });
            if(allDamagedContainers.length > 0) {
                if (DEBUG) console.log(`Builder ${creep.name}: Repairing containers - found ${allDamagedContainers.length} damaged containers`);
                const target = this.findReachableRepairTarget(creep, allDamagedContainers);
                if(target) {
                    const repairResult = creep.repair(target);
                    if(repairResult == ERR_NOT_IN_RANGE) {
                        const moveResult = creep.moveTo(target, {
                            visualizePathStyle: {stroke: '#ffffff'},
                            reusePath: 5
                        });
                        if(moveResult === ERR_NO_PATH) {
                            if (DEBUG) console.log(`Builder ${creep.name}: No path to container, skipping`);
                            return;
                        }
                        creep.say('📦');
                    }
                    delete creep.memory.repairingWallId;
                    return;
                }
            }

            // Priority 4: Repair damaged roads
            const allDamagedRoads = workingRoom.find(FIND_STRUCTURES, {
                filter: (structure) => structure.structureType === STRUCTURE_ROAD && structure.hits < structure.hitsMax * 0.75
            });
            if(allDamagedRoads.length > 0) {
                if (DEBUG) console.log(`Builder ${creep.name}: Repairing roads - found ${allDamagedRoads.length} damaged roads`);
                const target = this.findReachableRepairTarget(creep, allDamagedRoads);
                if(target) {
                    const repairResult = creep.repair(target);
                    if(repairResult == ERR_NOT_IN_RANGE) {
                        const moveResult = creep.moveTo(target, {
                            visualizePathStyle: {stroke: '#ffffff'},
                            reusePath: 5
                        });
                        if(moveResult === ERR_NO_PATH) {
                            if (DEBUG) console.log(`Builder ${creep.name}: No path to road, skipping`);
                            return;
                        }
                        creep.say('🛣️');
                    }
                    delete creep.memory.repairingWallId;
                    return;
                }
            }

            // Priority 5: Repair other damaged structures
            const allDamagedStructures = workingRoom.find(FIND_STRUCTURES, {
                filter: (structure) => structure.hits < structure.hitsMax * 0.75 &&
                    structure.structureType !== STRUCTURE_ROAD &&
                    structure.structureType !== STRUCTURE_CONTAINER &&
                    structure.structureType !== STRUCTURE_WALL &&
                    structure.structureType !== STRUCTURE_RAMPART
            });
            if(allDamagedStructures.length > 0) {
                if (DEBUG) console.log(`Builder ${creep.name}: Repairing other structures - found ${allDamagedStructures.length} damaged structures`);
                const target = this.findReachableRepairTarget(creep, allDamagedStructures);
                if(target) {
                    const repairResult = creep.repair(target);
                    if(repairResult == ERR_NOT_IN_RANGE) {
                        const moveResult = creep.moveTo(target, {
                            visualizePathStyle: {stroke: '#ffffff'},
                            reusePath: 5
                        });
                        if(moveResult === ERR_NO_PATH) {
                            if (DEBUG) console.log(`Builder ${creep.name}: No path to structure, skipping`);
                            return;
                        }
                        creep.say('🔧');
                    }
                    delete creep.memory.repairingWallId;
                    return;
                }
            }

            // Priority 6: Reinforce walls
            let target = null;
            if(creep.memory.repairingWallId) {
                target = Game.getObjectById(creep.memory.repairingWallId);
                if(!target || target.hits >= WALL_REPAIR_THRESHOLD || target.structureType !== STRUCTURE_WALL) {
                    delete creep.memory.repairingWallId;
                    delete creep.memory.targetAttempts;
                    target = null;
                } else {
                    // Check if stuck on wall target
                    if(this.isStuckOnTarget(creep, 'repairingWallId')) {
                        if (DEBUG) console.log(`Builder ${creep.name}: Stuck on wall target, finding new target`);
                        delete creep.memory.repairingWallId;
                        delete creep.memory.targetAttempts;
                        target = null;
                    }
                }
            }
            if(!target) {
                const allWeakWalls = workingRoom.find(FIND_STRUCTURES, {
                    filter: (structure) => 
                        structure.structureType === STRUCTURE_WALL &&
                        structure.hits < WALL_REPAIR_THRESHOLD
                });
                if(allWeakWalls.length > 0) {
                    if (DEBUG) console.log(`Builder ${creep.name}: Reinforcing walls - found ${allWeakWalls.length} weak walls`);
                    target = this.findReachableWallTarget(creep, allWeakWalls);
                    if(target) {
                        creep.memory.repairingWallId = target.id;
                        delete creep.memory.targetAttempts;
                        // Set work area for walls too
                        if(!creep.memory.workArea) {
                            creep.memory.workArea = {
                                x: target.pos.x,
                                y: target.pos.y,
                                roomName: target.pos.roomName
                            };
                            if (DEBUG) console.log(`Builder ${creep.name}: Found reachable wall at ${target.pos}, setting work area`);
                        }
                    }
                }
            }
            if(target) {
                const repairResult = creep.repair(target);
                if(repairResult == ERR_NOT_IN_RANGE) {
                    const moveResult = creep.moveTo(target, {
                        visualizePathStyle: {stroke: '#b7b7b7'},
                        reusePath: 5
                    });

                    if(moveResult === ERR_NO_PATH) {
                        if (DEBUG) console.log(`Builder ${creep.name}: No path to wall, abandoning target`);
                        delete creep.memory.repairingWallId;
                        delete creep.memory.targetAttempts;
                        return;
                    } else if(moveResult === OK) {
                        this.incrementTargetAttempts(creep, 'repairingWallId');
                    }

                    creep.say('🧱');
                } else if(repairResult == OK) {
                    delete creep.memory.targetAttempts;
                    creep.say('🧱');
                }
                return;
            }

            // Priority 7: Deposit energy into storage if idle
            if(creep.store[RESOURCE_ENERGY] > 0) {
                const storage = workingRoom.storage;
                if(storage && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    if (DEBUG) console.log(`Builder ${creep.name}: Depositing energy to storage - no other tasks available`);
                    const transferResult = creep.transfer(storage, RESOURCE_ENERGY);
                    if(transferResult == ERR_NOT_IN_RANGE) {
                        creep.moveTo(storage, {
                            visualizePathStyle: {stroke: '#ffffff'},
                            reusePath: 10
                        });
                        creep.say('📤 deposit');
                    }
                    delete creep.memory.repairingWallId;
                    return;
                }
            }

            // Priority 8: Upgrade controller if nothing else
            const controller = workingRoom.controller;
            if(controller) {
                if (DEBUG) console.log(`Builder ${creep.name}: Upgrading controller - no other tasks available`);
                const upgradeResult = creep.upgradeController(controller);
                if(upgradeResult == ERR_NOT_IN_RANGE) {
                    creep.moveTo(controller, {
                        visualizePathStyle: {stroke: '#ffffff'},
                        reusePath: 10
                    });
                    creep.say('⚡');
                }
            }
            delete creep.memory.repairingWallId;
        }
        // Harvesting mode
        else {
            if (DEBUG) console.log(`Builder ${creep.name}: In harvesting mode, looking for energy...`);
            const harvestingRoom = this.getHarvestingRoom(creep);

            // Only harvest in owned rooms
            if (!harvestingRoom) {
                if (DEBUG) console.log(`Builder ${creep.name}: No owned room to harvest in, idling`);
                return;
            }

            // First check for dropped resources
            const droppedResources = harvestingRoom.find(FIND_DROPPED_RESOURCES, {
                filter: resource => resource.resourceType === RESOURCE_ENERGY && resource.amount > 50
            });
            if(droppedResources.length > 0) {
                if (DEBUG) console.log(`Builder ${creep.name}: Collecting dropped energy - found ${droppedResources.length} resources`);
                const closestResource = creep.pos.findClosestByPath(droppedResources);
                if(closestResource) {
                    if(creep.pickup(closestResource) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(closestResource, {
                            visualizePathStyle: {stroke: '#ffaa00'},
                            reusePath: 10
                        });
                        creep.say('📥');
                    }
                    return;
                }
            }

            // Storage structures
            const energySources = [];
            if(harvestingRoom.storage && harvestingRoom.storage.store[RESOURCE_ENERGY] > 100) {
                energySources.push(harvestingRoom.storage);
            }
            if(harvestingRoom.terminal && harvestingRoom.terminal.store[RESOURCE_ENERGY] > 100) {
                energySources.push(harvestingRoom.terminal);
            }
            const containers = harvestingRoom.find(FIND_STRUCTURES, {
                filter: structure => structure.structureType === STRUCTURE_CONTAINER && structure.store[RESOURCE_ENERGY] > 50
            });
            energySources.push(...containers);

            if(energySources.length > 0) {
                if (DEBUG) console.log(`Builder ${creep.name}: Withdrawing from storage structures - found ${energySources.length} sources`);
                const closest = creep.pos.findClosestByPath(energySources);
                if(closest) {
                    if(creep.withdraw(closest, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(closest, {
                            visualizePathStyle: {stroke: '#ffaa00'},
                            reusePath: 10
                        });
                        creep.say('📦');
                    }
                    return;
                }
            }

            // Energy sources
            const sources = harvestingRoom.find(FIND_SOURCES_ACTIVE);
            if(sources.length > 0) {
                if (DEBUG) console.log(`Builder ${creep.name}: Harvesting from energy source - found ${sources.length} active sources`);
                const source = creep.pos.findClosestByPath(sources);
                if(source) {
                    if(creep.harvest(source) == ERR_NOT_IN_RANGE) {
                        creep.moveTo(source, {
                            visualizePathStyle: {stroke: '#ffaa00'},
                            reusePath: 10
                        });
                        creep.say('⛏️');
                    }
                }
            } else {
                if (DEBUG) console.log(`Builder ${creep.name}: No energy sources available in room ${harvestingRoom.name}`);
            }
        }
    },

    // Track attempts to reach a target and detect if stuck
    incrementTargetAttempts: function(creep, targetKey) {
        if(!creep.memory.targetAttempts) {
            creep.memory.targetAttempts = {};
        }
        const targetId = creep.memory[targetKey];
        if(!creep.memory.targetAttempts[targetId]) {
            creep.memory.targetAttempts[targetId] = 0;
        }
        creep.memory.targetAttempts[targetId]++;
    },

    // Check if creep is stuck on a target
    isStuckOnTarget: function(creep, targetKey) {
        if(!creep.memory.targetAttempts) {
            return false;
        }
        const targetId = creep.memory[targetKey];
        if(!targetId || !creep.memory.targetAttempts[targetId]) {
            return false;
        }
        return creep.memory.targetAttempts[targetId] >= MAX_STUCK_ATTEMPTS;
    },

    // Find a reachable construction site by testing actual movement
    findReachableConstructionSite: function(creep, constructionSites) {
        // If we have a work area, prioritize sites in that area first
        if(creep.memory.workArea) {
            const workAreaSites = constructionSites.filter(site => {
                if(site.pos.roomName !== creep.memory.workArea.roomName) return false;
                const distance = Math.max(
                    Math.abs(site.pos.x - creep.memory.workArea.x),
                    Math.abs(site.pos.y - creep.memory.workArea.y)
                );
                return distance <= WORK_AREA_RANGE;
            });

            if(workAreaSites.length > 0) {
                if (DEBUG) console.log(`Builder ${creep.name}: Checking ${workAreaSites.length} sites in work area first`);
                // Sort by progress
                workAreaSites.sort((a, b) => (b.progress / b.progressTotal) - (a.progress / a.progressTotal));
                for(let site of workAreaSites.slice(0, 3)) { // Try top 3 in work area
                    if(this.canReachTarget(creep, site)) {
                        if (DEBUG) console.log(`Builder ${creep.name}: Found reachable site in work area: ${site.structureType} at ${site.pos}`);
                        return site;
                    }
                }
            }
        }

        // Try random sites from the full list
        if (DEBUG) console.log(`Builder ${creep.name}: Trying random construction sites to find reachable one`);
        const shuffledSites = _.shuffle(constructionSites);
        const maxTries = Math.min(5, shuffledSites.length); // Try fewer sites for performance

        for(let i = 0; i < maxTries; i++) {
            const site = shuffledSites[i];
            if(this.canReachTarget(creep, site)) {
                if (DEBUG) console.log(`Builder ${creep.name}: Found reachable site: ${site.structureType} at ${site.pos}`);
                return site;
            }
        }

        if (DEBUG) console.log(`Builder ${creep.name}: No reachable construction sites found after trying ${maxTries} sites`);
        return null;
    },

    // Find a reachable repair target
    findReachableRepairTarget: function(creep, structures) {
        // If we have a work area, prioritize structures in that area first
        if(creep.memory.workArea) {
            const workAreaStructures = structures.filter(structure => {
                if(structure.pos.roomName !== creep.memory.workArea.roomName) return false;
                const distance = Math.max(
                    Math.abs(structure.pos.x - creep.memory.workArea.x),
                    Math.abs(structure.pos.y - creep.memory.workArea.y)
                );
                return distance <= WORK_AREA_RANGE;
            });

            if(workAreaStructures.length > 0) {
                // Sort by damage in work area
                workAreaStructures.sort((a, b) => (a.hits / a.hitsMax) - (b.hits / b.hitsMax));
                for(let structure of workAreaStructures.slice(0, 3)) {
                    if(this.canReachTarget(creep, structure)) {
                        return structure;
                    }
                }
            }
        }

        // Try random structures
        const shuffledStructures = _.shuffle(structures);
        const maxTries = Math.min(3, shuffledStructures.length);

        for(let i = 0; i < maxTries; i++) {
            const structure = shuffledStructures[i];
            if(this.canReachTarget(creep, structure)) {
                return structure;
            }
        }

        return null;
    },

    // Find a reachable wall target
    findReachableWallTarget: function(creep, walls) {
        // Filter out walls being worked on by other builders
        const otherBuilders = _.filter(Game.creeps, (otherCreep) => 
            otherCreep.memory.role === 'builder' && 
            otherCreep.memory.building && 
            otherCreep.name !== creep.name &&
            otherCreep.memory.repairingWallId
        );

        let availableWalls = walls.filter(wall => {
            const buildersOnThisWall = otherBuilders.filter(builder => 
                builder.memory.repairingWallId === wall.id
            );
            return buildersOnThisWall.length === 0;
        });

        if(availableWalls.length === 0) {
            availableWalls = walls; // If all walls are taken, just pick any
        }

        // If we have a work area, prioritize walls in that area first
        if(creep.memory.workArea) {
            const workAreaWalls = availableWalls.filter(wall => {
                if(wall.pos.roomName !== creep.memory.workArea.roomName) return false;
                const distance = Math.max(
                    Math.abs(wall.pos.x - creep.memory.workArea.x),
                    Math.abs(wall.pos.y - creep.memory.workArea.y)
                );
                return distance <= WORK_AREA_RANGE;
            });

            if(workAreaWalls.length > 0) {
                // Sort by hits (weakest first) in work area
                workAreaWalls.sort((a, b) => a.hits - b.hits);
                for(let wall of workAreaWalls.slice(0, 3)) {
                    if(this.canReachTarget(creep, wall)) {
                        return wall;
                    }
                }
            }
        }

        // Try random walls
        const shuffledWalls = _.shuffle(availableWalls);
        const maxTries = Math.min(3, shuffledWalls.length);

        for(let i = 0; i < maxTries; i++) {
            const wall = shuffledWalls[i];
            if(this.canReachTarget(creep, wall)) {
                return wall;
            }
        }

        return null;
    },

    // Better pathfinding check with range 1 for building/repair
    canReachTarget: function(creep, target) {
        // Use range 1 for building/repair actions
        const path = creep.pos.findPathTo(target.pos, {
            ignoreCreeps: true,
            range: 1,
            maxOps: 1000 // Limit CPU usage
        });
        return path.length > 0;
    },

    // Find construction sites across assigned room and current room, but only in owned rooms
    findConstructionSites: function(creep) {
        let constructionSites = [];

        // Only add sites from rooms you own
        if (creep.room.controller && creep.room.controller.my) {
            constructionSites.push(...creep.room.find(FIND_CONSTRUCTION_SITES));
        }

        // Check assigned room if different from current room and owned
        const assignedRoom = creep.memory.assignedRoom;
        if(assignedRoom && assignedRoom !== creep.room.name && Game.rooms[assignedRoom] && Game.rooms[assignedRoom].controller && Game.rooms[assignedRoom].controller.my) {
            constructionSites.push(...Game.rooms[assignedRoom].find(FIND_CONSTRUCTION_SITES));
        }

        // If still no construction sites, check all owned rooms
        if(constructionSites.length === 0) {
            for(const roomName in Game.rooms) {
                const room = Game.rooms[roomName];
                if(room.controller && room.controller.my && roomName !== creep.room.name) {
                    constructionSites.push(...room.find(FIND_CONSTRUCTION_SITES));
                }
            }
        }

        return constructionSites;
    },

    // Get the room where the creep should do repair/building work, only if owned
    getWorkingRoom: function(creep) {
        // Prefer assigned room if it exists and has visibility and is owned
        const assignedRoom = creep.memory.assignedRoom;
        if(assignedRoom && Game.rooms[assignedRoom] && Game.rooms[assignedRoom].controller && Game.rooms[assignedRoom].controller.my) {
            return Game.rooms[assignedRoom];
        }

        // Only return current room if owned
        if (creep.room.controller && creep.room.controller.my) {
            return creep.room;
        }

        // If not owned, return null (handle this in run)
        return null;
    },

    // Get the room where the creep should harvest energy, only if owned
    getHarvestingRoom: function(creep) {
        // Only harvest in owned rooms
        if (creep.room.controller && creep.room.controller.my &&
            (creep.room.find(FIND_SOURCES_ACTIVE).length > 0 || 
             creep.room.storage || 
             creep.room.find(FIND_STRUCTURES, {filter: s => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0}).length > 0)) {
            return creep.room;
        }

        const assignedRoom = creep.memory.assignedRoom;
        if(assignedRoom && Game.rooms[assignedRoom] && Game.rooms[assignedRoom].controller && Game.rooms[assignedRoom].controller.my) {
            return Game.rooms[assignedRoom];
        }

        // No owned room to harvest in
        return null;
    }
};

module.exports = roleBuilder;
