/**
 * taskScheduler.js
 * ================
 * Persist console commands to Memory and re-execute them every N ticks.
 *
 * GLOBAL COMMANDS (exposed in main.js):
 *
 *   schedule("cmd", interval, [offset])
 *     Register a command string to run every <interval> ticks.
 *     Optional <offset> shifts the phase (default: current tick % interval).
 *     Returns the numeric task ID.
 *
 *   unschedule(id)
 *     Remove a scheduled task by ID.
 *
 *   listScheduled()
 *     Print all active scheduled tasks.
 *
 *   runScheduled(id)
 *     Force-run a specific task immediately (ignores tick gate).
 *
 *   updateScheduled(id, {command?, interval?, offset?})
 *     Update one or more fields on an existing task.
 */

'use strict';

const taskScheduler = {

  // ----------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------

  _init: function() {
    if (!Memory.taskScheduler) {
      Memory.taskScheduler = { nextId: 1, tasks: {} };
    }
    if (!Memory.taskScheduler.tasks)  Memory.taskScheduler.tasks  = {};
    if (!Memory.taskScheduler.nextId) Memory.taskScheduler.nextId = 1;
  },

  _exec: function(task) {
    try {
      // eslint-disable-next-line no-eval
      const result = eval(task.command);
      task.lastRan    = Game.time;
      task.runCount   = (task.runCount || 0) + 1;
      task.lastResult = (result !== undefined) ? String(result).slice(0, 120) : 'ok';
      console.log('[Scheduler] Task #' + task.id + ' ran: ' + task.command
        + (task.lastResult !== 'ok' ? ' → ' + task.lastResult : ''));
    } catch (e) {
      task.lastError  = e.toString();
      task.lastRan    = Game.time;
      task.runCount   = (task.runCount || 0) + 1;
      console.log('[Scheduler] ERROR in task #' + task.id + ' (' + task.command + '): ' + e);
    }
  },

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Register a command to run every <interval> ticks.
   * @param {string} command   - JS expression (same as console input)
   * @param {number} interval  - ticks between executions (>= 1)
   * @param {number} [offset]  - phase offset; defaults to Game.time % interval
   *                             so the first run is on the NEXT due tick.
   * @returns {number} task id
   */
  schedule: function(command, interval, offset) {
    this._init();

    if (typeof command !== 'string' || !command.trim()) {
      console.log('[Scheduler] ERROR: command must be a non-empty string.');
      return null;
    }

    interval = Math.max(1, Math.floor(interval) || 1);

    // Default offset keeps the existing tick phase so it first fires at
    // Game.time + (interval - Game.time % interval).
    if (offset === undefined) offset = Game.time % interval;

    const id = Memory.taskScheduler.nextId++;
    Memory.taskScheduler.tasks[id] = {
      id:        id,
      command:   command,
      interval:  interval,
      offset:    offset % interval,
      createdAt: Game.time,
      runCount:  0,
      lastRan:   null,
      lastResult: null,
      lastError:  null,
    };

    const nextDue = interval - ((Game.time - offset) % interval);
    console.log('[Scheduler] Task #' + id + ' registered.'
      + ' Runs every ' + interval + ' ticks.'
      + ' Next execution in ~' + nextDue + ' ticks.'
      + ' Command: ' + command);

    return id;
  },

  /**
   * Remove a task by ID.
   */
  unschedule: function(id) {
    this._init();

    id = Number(id);
    if (!Memory.taskScheduler.tasks[id]) {
      console.log('[Scheduler] No task with id #' + id + ' found.');
      return false;
    }

    const task = Memory.taskScheduler.tasks[id];
    delete Memory.taskScheduler.tasks[id];
    console.log('[Scheduler] Task #' + id + ' removed. (' + task.command + ')');
    return true;
  },

  /**
   * Update an existing task. Pass any of: command, interval, offset.
   * @param {number} id
   * @param {{command?: string, interval?: number, offset?: number}} updates
   */
  update: function(id, updates) {
    this._init();

    id = Number(id);
    const task = Memory.taskScheduler.tasks[id];
    if (!task) {
      console.log('[Scheduler] No task with id #' + id + '.');
      return false;
    }

    if (!updates || typeof updates !== 'object') {
      console.log('[Scheduler] ERROR: updates must be an object, e.g. {interval: 50}.');
      return false;
    }

    const changes = [];

    if (updates.command !== undefined) {
      if (typeof updates.command !== 'string' || !updates.command.trim()) {
        console.log('[Scheduler] ERROR: command must be a non-empty string.');
        return false;
      }
      changes.push('command: "' + task.command + '" → "' + updates.command + '"');
      task.command = updates.command;
    }

    if (updates.interval !== undefined) {
      const newInterval = Math.max(1, Math.floor(updates.interval) || 1);
      if (newInterval !== task.interval) {
        changes.push('interval: ' + task.interval + ' → ' + newInterval);
        task.interval = newInterval;
        // Re-normalize offset against the new interval if caller didn't set one
        if (updates.offset === undefined) task.offset = task.offset % newInterval;
      }
    }

    if (updates.offset !== undefined) {
      const newOffset = ((Math.floor(updates.offset) % task.interval) + task.interval) % task.interval;
      if (newOffset !== task.offset) {
        changes.push('offset: ' + task.offset + ' → ' + newOffset);
        task.offset = newOffset;
      }
    }

    if (changes.length === 0) {
      console.log('[Scheduler] Task #' + id + ' update: nothing changed. Recognized fields: command, interval, offset.');
      return false;
    }

    // Clear stale error/result so the next run reflects the updated task
    task.lastError = null;

    const nextDue = task.interval - ((Game.time - task.offset) % task.interval);
    console.log('[Scheduler] Task #' + id + ' updated — ' + changes.join('; ')
      + '. Next execution in ~' + nextDue + ' ticks.');

    return true;
  },

  /**
   * Print all registered tasks.
   */
  list: function() {
    this._init();

    const tasks = Memory.taskScheduler.tasks;
    const ids   = Object.keys(tasks);

    if (ids.length === 0) {
      console.log('[Scheduler] No scheduled tasks.');
      return;
    }

    console.log('=== SCHEDULED TASKS (' + ids.length + ') ===');
    for (const id of ids) {
      const t       = tasks[id];
      const due     = t.interval - ((Game.time - t.offset) % t.interval);
      const lastRan = t.lastRan !== null ? ('tick ' + t.lastRan) : 'never';
      console.log(
        '  #' + t.id
        + ' | every ' + t.interval + ' ticks'
        + ' | next in ' + due
        + ' | ran ' + t.runCount + 'x'
        + ' | last: ' + lastRan
        + (t.lastError ? ' | ERR: ' + t.lastError : '')
        + '\n      CMD: ' + t.command
      );
    }
    console.log('=== END ===');
  },

  /**
   * Force-execute a task right now regardless of tick gate.
   */
  forceRun: function(id) {
    this._init();

    id = Number(id);
    const task = Memory.taskScheduler.tasks[id];
    if (!task) {
      console.log('[Scheduler] No task with id #' + id + '.');
      return false;
    }

    console.log('[Scheduler] Force-running task #' + id + '...');
    this._exec(task);
    return true;
  },

  // ----------------------------------------------------------------
  // Called once per tick from main loop
  // ----------------------------------------------------------------
  run: function() {
    this._init();

    const tasks = Memory.taskScheduler.tasks;
    for (const id in tasks) {
      const task = tasks[id];

      // Fire when (Game.time - offset) is an exact multiple of interval
      if ((Game.time - task.offset) % task.interval === 0) {
        this._exec(task);
      }
    }
  },
};

module.exports = taskScheduler;
