/**
 * marketLabForward.js  --  thin shim around the consolidated marketLab module.
 *
 * The real implementation lives in marketLab.js. This file exists so that
 * existing `require('marketLabForward')` calls (and profiler registrations
 * keyed on the old module name) continue to work without changes.
 *
 * Safe to delete once main.js has been switched over to require('marketLab').
 */

var marketLab = require('marketLab');

module.exports = {
    // Only processes forward operations -- accurate CPU attribution under the
    // existing main.js layout which has separate profileSection calls for
    // marketLabForward.run and marketLabReverse.run.
    run: function() { marketLab.runForward(); }
};