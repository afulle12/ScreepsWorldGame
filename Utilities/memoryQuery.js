// LLM: Read llmcontext.js before reviewing or changing this file.
/**
 * memoryQuery.js
 * Utility module to search through Memory and print Memory sub-trees.
 *
 * Console usage (callable from the Screeps console):
 *   memoryQuery()                        - Print help with examples
 *   memoryQuery('help')                  - Print help with examples
 *   memoryQuery('searchTerm')            - Search for term in keys and values
 *   memoryQuery('searchTerm', true)      - Case-sensitive search
 *   memoryQuery('creeps')                - Print Memory.creeps as JSON
 *   memoryQuery('Memory.rooms.W1N1')     - Print a sub-tree (accepts Memory. prefix)
 *   memoryQuery('rooms.W1N1.sources[0]') - Array indices supported
 *   memoryQueryKeys('searchTerm')        - Search only in keys
 *   memoryQueryValues('searchTerm')      - Search only in values
 *   memoryGet('creeps.MyCreep.role')     - Get and print a single value
 *   memoryPrint('creeps')                - Force print mode (never searches)
 *   memoryOverview()                     - List top-level Memory keys with sizes
 *
 * Examples:
 *   memoryQuery('harvester')             // search keys + values, case-insensitive
 *   memoryQuery('harvester', true)       // case-sensitive search
 *   memoryQuery('Memory.creeps')         // print the whole Memory.creeps object
 *   memoryQuery('rooms.W1N1.sources[0]') // print a single array element
 *   memoryPrint('creeps.MyCreep.role')   // print one field
 *   memoryGet('creeps.MyCreep.role')     // alias of memoryPrint
 *   memoryOverview()                     // list top-level Memory keys
 *
 * Return values:
 *   memoryQuery / memoryPrint           -> "Printed Memory.<path> to console."
 *                                          (or "No matches found for ...",
 *                                          "Path not found: ...", or a count
 *                                          summary depending on the call)
 *   memoryGet                            -> returns the resolved value itself
 *   memoryQueryKeys / memoryQueryValues -> count summary, like memoryQuery
 *   memoryOverview                       -> "See console for Memory overview."
 *   memoryQuery() / memoryQuery('help')  -> prints the help block to console
 *
 * Path syntax:
 *   Dot-notation with an optional "Memory." prefix. Array indices use
 *   bracketed form, e.g. rooms.W1N1.sources[0].
 *
 * Search limits:
 *   Search returns every match (no result cap). Only a depth limit
 *   (MAX_DEPTH) is enforced to protect against cyclic structures.
 */

const MAX_DEPTH = 20;
const MAX_VALUE_PREVIEW = 100;

const HELP_TEXT =
    '=== memoryQuery help ===\n' +
    'Search Memory or print a Memory sub-tree as JSON.\n\n' +
    'Functions:\n' +
    '  memoryQuery(term, [caseSensitive], [options]) - search or print path\n' +
    '  memoryQueryKeys(term, [caseSensitive])        - search keys only\n' +
    '  memoryQueryValues(term, [caseSensitive])      - search values only\n' +
    '  memoryGet(path)                               - get + print a Memory value\n' +
    '  memoryPrint(path)                             - force-print a Memory path\n' +
    '  memoryOverview()                              - list top-level Memory keys\n\n' +
    'Returns:\n' +
    '  search mode  -> "Found N match(es). See console for details."\n' +
    '  path mode    -> "Printed Memory.<path> to console."\n' +
    '  memoryGet    -> returns the actual value (not a string)\n\n' +
    'Path syntax:\n' +
    '  dot-notation with optional Memory. prefix\n' +
    '  array indices via [n], e.g. rooms.W1N1.sources[0]\n\n' +
    'Examples:\n' +
    '  memoryQuery()\n' +
    '  memoryQuery("harvester")             // search keys + values\n' +
    '  memoryQuery("harvester", true)       // case-sensitive search\n' +
    '  memoryQuery("creeps")                // print Memory.creeps\n' +
    '  memoryQuery("Memory.rooms.W1N1")     // accept Memory. prefix\n' +
    '  memoryQuery("rooms.W1N1.sources[0]") // array index support\n' +
    '  memoryPrint("creeps.MyCreep.role")   // print one field\n' +
    '  memoryOverview()                     // show top-level keys + sizes\n';

function searchObject(obj, searchTerm, currentPath, results, options, depth) {
    if (depth > MAX_DEPTH) return;
    if (obj === null || obj === undefined) return;

    const searchLower = options.caseSensitive ? searchTerm : searchTerm.toLowerCase();

    if (typeof obj === 'object' && !Array.isArray(obj)) {
        for (const key in obj) {
            const newPath = currentPath ? currentPath + '.' + key : key;
            const keyToCheck = options.caseSensitive ? key : key.toLowerCase();

            // Check if key matches
            if (options.searchKeys && keyToCheck.includes(searchLower)) {
                results.push({
                    path: 'Memory.' + newPath,
                    matchType: 'key',
                    key: key,
                    valuePreview: getValuePreview(obj[key])
                });
            }

            // Check if value matches (for primitive values)
            if (options.searchValues && isPrimitive(obj[key])) {
                const valueStr = String(obj[key]);
                const valueToCheck = options.caseSensitive ? valueStr : valueStr.toLowerCase();
                if (valueToCheck.includes(searchLower)) {
                    results.push({
                        path: 'Memory.' + newPath,
                        matchType: 'value',
                        key: key,
                        value: valueStr.substring(0, MAX_VALUE_PREVIEW)
                    });
                }
            }

            // Recurse into nested objects/arrays
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                searchObject(obj[key], searchTerm, newPath, results, options, depth + 1);
            }
        }
    } else if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            const newPath = currentPath + '[' + i + ']';

            // Check if array element value matches (for primitives)
            if (options.searchValues && isPrimitive(obj[i])) {
                const valueStr = String(obj[i]);
                const valueToCheck = options.caseSensitive ? valueStr : valueStr.toLowerCase();
                if (valueToCheck.includes(searchLower)) {
                    results.push({
                        path: 'Memory.' + newPath,
                        matchType: 'value',
                        key: '[' + i + ']',
                        value: valueStr.substring(0, MAX_VALUE_PREVIEW)
                    });
                }
            }

            // Recurse into nested objects/arrays
            if (typeof obj[i] === 'object' && obj[i] !== null) {
                searchObject(obj[i], searchTerm, newPath, results, options, depth + 1);
            }
        }
    }
}

function isPrimitive(val) {
    return val === null || (typeof val !== 'object' && typeof val !== 'function');
}

/**
 * Strip an optional "Memory." prefix and split a path into segments.
 * Supports dot-notation and array indices, e.g. "rooms.W1N1.sources[0]".
 * Returns null if the input is not a non-empty string.
 */
function parseMemoryPath(path) {
    if (!path || typeof path !== 'string') return null;
    let p = path.trim();
    if (p.length === 0) return null;
    if (p.toLowerCase().indexOf('memory.') === 0) p = p.substring(7);
    if (p.length === 0) return null;
    const parts = p.replace(/\[(\d+)\]/g, '.$1').split('.');
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '') return null;
    }
    return parts;
}

/**
 * Resolve a path against Memory.
 * @param {string} path - Memory path; optional "Memory." prefix is stripped.
 * @returns {{found: boolean, value: *, path: string, failedAt?: string}}
 *   found is true if every segment resolved to a defined value.
 *   value is the resolved value (or undefined when not found).
 *   path is the original input string.
 *   failedAt is the first segment that could not be resolved (when applicable).
 */
function resolveMemoryPath(path) {
    const parts = parseMemoryPath(path);
    if (!parts) return { found: false, value: undefined, path: path };
    let current = Memory;
    for (let i = 0; i < parts.length; i++) {
        if (current === null || current === undefined) {
            return { found: false, value: undefined, path: path, failedAt: parts[i] };
        }
        current = current[parts[i]];
    }
    return { found: current !== undefined, value: current, path: path };
}

function formatValueForPrint(val) {
    try {
        return JSON.stringify(val, null, 2);
    } catch (e) {
        return String(val);
    }
}

/**
 * Print a Memory sub-tree resolved from `path` as a single combined
 * `console.log` call so Screeps does not insert a timestamp between the
 * header and the JSON.
 * @param {string} path - Memory path; optional "Memory." prefix accepted.
 * @returns {string} "Printed Memory.<path> to console." on success,
 *   or "Path not found: <path>" when the path does not resolve.
 */
function printMemoryPath(path) {
    const res = resolveMemoryPath(path);
    if (!res.found) {
        return 'Path not found: ' + res.path;
    }
    const displayPath = res.path.toLowerCase().indexOf('memory.') === 0
        ? res.path
        : 'Memory.' + res.path;
    console.log(displayPath + ' =\n' + formatValueForPrint(res.value));
    return 'Printed ' + displayPath + ' to console.';
}

function getValuePreview(val) {
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'object') {
        if (Array.isArray(val)) {
            return '[Array(' + val.length + ')]';
        }
        const keys = Object.keys(val);
        if (keys.length <= 3) {
            return '{' + keys.join(', ') + '}';
        }
        return '{' + keys.slice(0, 3).join(', ') + ', ... +' + (keys.length - 3) + ' more}';
    }
    const str = String(val);
    return str.length > MAX_VALUE_PREVIEW ? str.substring(0, MAX_VALUE_PREVIEW) + '...' : str;
}

/**
 * Main search function. If the first argument resolves to a Memory path,
 * prints that sub-tree as JSON instead of searching. Search returns every
 * match (no result cap; only a recursion depth limit applies).
 * @param {string} [searchTerm] - Term to search for, or a Memory path to
 *   print. Omit (or pass "help") to print the help block.
 * @param {boolean} [caseSensitive=false] - Whether search is case-sensitive.
 * @param {Object} [searchOptions] - Optional search options:
 *   - searchKeys {boolean}   - include keys in the search (default true)
 *   - searchValues {boolean} - include values in the search (default true)
 * @returns {string} For path mode: "Printed Memory.<path> to console."
 *   For search mode: "Found N match(es). See console for details." or
 *   "No matches found for <term>". For no-arg / "help": a help pointer.
 */
function memoryQuery(searchTerm, caseSensitive, searchOptions) {
    if (!searchTerm || typeof searchTerm !== 'string') {
        console.log(HELP_TEXT);
        return 'See console for memoryQuery usage and examples.';
    }
    if (typeof searchTerm === 'string' && searchTerm.toLowerCase() === 'help') {
        console.log(HELP_TEXT);
        return 'See console for memoryQuery usage and examples.';
    }

    if (parseMemoryPath(searchTerm)) {
        const res = resolveMemoryPath(searchTerm);
        if (res.found) {
            return printMemoryPath(searchTerm);
        }
    }

    const options = {
        caseSensitive: caseSensitive || false,
        searchKeys: true,
        searchValues: true
    };

    if (searchOptions) {
        if (searchOptions.searchKeys !== undefined) options.searchKeys = searchOptions.searchKeys;
        if (searchOptions.searchValues !== undefined) options.searchValues = searchOptions.searchValues;
    }

    const results = [];
    searchObject(Memory, searchTerm, '', results, options, 0);

    if (results.length === 0) {
        return 'No matches found for "' + searchTerm + '"';
    }

    let output = '=== Memory Search Results for "' + searchTerm + '" ===\n';
    output += 'Found ' + results.length + ' match' + (results.length === 1 ? '' : 'es') + '\n\n';

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.matchType === 'key') {
            output += '[KEY]   ' + r.path + '\n';
            output += '        Preview: ' + r.valuePreview + '\n';
        } else {
            output += '[VALUE] ' + r.path + '\n';
            output += '        Value: ' + r.value + '\n';
        }
    }

    console.log(output);
    return 'Found ' + results.length + ' match(es). See console for details.';
}

/**
 * Search only in keys. Falls through to memoryQuery so the same
 * path-vs-search dispatch applies.
 * @param {string} searchTerm - Term to search for in keys, or a Memory path.
 * @param {boolean} [caseSensitive=false] - Whether the search is case-sensitive.
 * @returns {string} Same as memoryQuery: status string for the resolved call.
 */
function memoryQueryKeys(searchTerm, caseSensitive) {
    return memoryQuery(searchTerm, caseSensitive, { searchKeys: true, searchValues: false });
}

/**
 * Search only in values. Falls through to memoryQuery so the same
 * path-vs-search dispatch applies.
 * @param {string} searchTerm - Term to search for in values, or a Memory path.
 * @param {boolean} [caseSensitive=false] - Whether the search is case-sensitive.
 * @returns {string} Same as memoryQuery: status string for the resolved call.
 */
function memoryQueryValues(searchTerm, caseSensitive) {
    return memoryQuery(searchTerm, caseSensitive, { searchKeys: false, searchValues: true });
}

/**
 * Get the value at a specific memory path. Prints the resolved sub-tree
 * to the console and returns the actual value (not a string).
 * @param {string} path - Dot-notation path; "Memory." prefix is accepted.
 *   Array indices via [n] are supported, e.g. "rooms.W1N1.sources[0]".
 * @returns {*} The resolved value, or a string error message if the path
 *   is invalid / not found.
 */
function memoryGet(path) {
    if (!path || typeof path !== 'string') {
        return 'Usage: memoryGet("path.to.value")';
    }

    const res = resolveMemoryPath(path);
    if (!res.found) {
        return 'Path not found: ' + path;
    }

    const displayPath = path.toLowerCase().indexOf('memory.') === 0
        ? path
        : 'Memory.' + path;
    console.log(displayPath + ' =\n' + formatValueForPrint(res.value));
    return res.value;
}

/**
 * Force print mode: treats the argument strictly as a Memory path and
 * prints the resolved sub-tree as JSON. Never searches.
 * @param {string} path - Dot-notation path; "Memory." prefix is accepted.
 *   Array indices via [n] are supported.
 * @returns {string} "Printed Memory.<path> to console." on success,
 *   or an error string if the path is invalid / not found.
 */
function memoryPrint(path) {
    if (!path || typeof path !== 'string') {
        return 'Usage: memoryPrint("path.to.value")';
    }
    if (!parseMemoryPath(path)) {
        return 'Invalid path: ' + path;
    }
    return printMemoryPath(path);
}

/**
 * List all top-level keys in Memory with their types and sizes. Prints a
 * summary to the console and returns a short status string.
 * @returns {string} "See console for Memory overview."
 */
function memoryOverview() {
    let output = '=== Memory Overview ===\n';
    const totalSize = JSON.stringify(Memory).length;
    output += 'Total Memory Size: ' + (totalSize / 1024).toFixed(2) + ' KB\n\n';

    const keys = Object.keys(Memory).sort();
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const val = Memory[key];
        const size = JSON.stringify(val).length;
        const sizeStr = size > 1024 ? (size / 1024).toFixed(2) + ' KB' : size + ' B';

        let typeStr;
        if (val === null) {
            typeStr = 'null';
        } else if (Array.isArray(val)) {
            typeStr = 'Array[' + val.length + ']';
        } else if (typeof val === 'object') {
            typeStr = 'Object{' + Object.keys(val).length + ' keys}';
        } else {
            typeStr = typeof val;
        }

        output += '  ' + key.padEnd(25) + ' ' + typeStr.padEnd(20) + ' ' + sizeStr + '\n';
    }

    console.log(output);
    return 'See console for Memory overview.';
}

/**
 * Memory size profiler (merged from the former memoryProfiler.js).
 * Usage:
 *   memoryProfile()                 // profile top-level Memory keys
 *   memoryProfile('creeps')         // profile Memory.creeps subtree
 *   memoryProfile('rooms.W1N1')     // profile Memory.rooms.W1N1 subtree
 *
 * Size is approximate: length of JSON.stringify(value). Output is one
 * contiguous console.log() block (size / percent / key), followed by the
 * measured JSON.stringify(Memory) CPU cost.
 */
function _profileGetSize(value) {
    var json;
    try {
        json = JSON.stringify(value);
    } catch (e) {
        return { size: 0, error: e && e.message ? e.message : 'stringify failed' };
    }
    return { size: json.length };
}

function _profileObject(obj, label, serializationCpu) {
    var total = 0;
    var entries = [];

    for (var key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
            continue;
        }

        var info = _profileGetSize(obj[key]);
        var size = info.size;

        total += size;
        entries.push({
            key: key,
            size: size
        });
    }

    if (entries.length === 0) {
        var msg = "No enumerable keys under " + label;
        if (typeof serializationCpu === 'number') {
            msg += "\nMemory serialization CPU (JSON.stringify(Memory)): " +
                   serializationCpu.toFixed(3);
        }
        console.log(msg);
        return;
    }

    entries.sort(function(a, b) {
        return b.size - a.size;
    });

    var lines = [];
    lines.push("size\tpercent\tkey (" + label + ".*)");

    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var pct = total > 0 ? (entry.size / total * 100) : 0;

        lines.push(
            entry.size + "\t" +
            pct.toFixed(2) + "\t" +
            label + "." + entry.key
        );
    }

    lines.push(
        "Total:\t" +
        total + "\t" +
        "100.00\t" +
        label
    );

    if (typeof serializationCpu === 'number') {
        lines.push("");
        lines.push(
            "Memory serialization CPU (JSON.stringify(Memory)): " +
            serializationCpu.toFixed(3)
        );
    }

    console.log(lines.join('\n'));
}

function memoryProfile(path) {
    var cpuBefore = Game.cpu.getUsed();
    JSON.stringify(Memory);
    var serializationCpu = Game.cpu.getUsed() - cpuBefore;

    if (!path) {
        _profileObject(Memory, "Memory", serializationCpu);
        return;
    }

    var parts = path.split('.');
    var node = Memory;
    var fullPath = "Memory";

    for (var i = 0; i < parts.length; i++) {
        var part = parts[i];

        if (typeof node[part] === 'undefined') {
            var lines = [];
            lines.push("Path not found in Memory: " + fullPath + "." + part);
            lines.push(
                "Memory serialization CPU (JSON.stringify(Memory)): " +
                serializationCpu.toFixed(3)
            );
            console.log(lines.join('\n'));
            return;
        }

        node = node[part];
        fullPath += "." + part;
    }

    if (node === null || typeof node !== 'object') {
        var info = _profileGetSize(node);
        var leafLines = [];
        leafLines.push("size\tpercent\tkey");
        leafLines.push(info.size + "\t100.00\t" + fullPath);
        leafLines.push("");
        leafLines.push(
            "Memory serialization CPU (JSON.stringify(Memory)): " +
            serializationCpu.toFixed(3)
        );
        console.log(leafLines.join('\n'));
        return;
    }

    _profileObject(node, fullPath, serializationCpu);
}

/**
 * Console globals exposed:
 *   memoryQuery       - search/print dispatch (path resolves to print)
 *   memoryQueryKeys   - search only in keys
 *   memoryQueryValues - search only in values
 *   memoryGet         - get + print a Memory value; returns the value
 *   memoryPrint       - force-print a Memory path; returns a status string
 *   memoryOverview    - top-level Memory keys with types and sizes
 *   memoryProfile     - Memory (or subtree) size breakdown + stringify CPU
 */
global.memoryQuery = memoryQuery;
global.memoryQueryKeys = memoryQueryKeys;
global.memoryQueryValues = memoryQueryValues;
global.memoryGet = memoryGet;
global.memoryPrint = memoryPrint;
global.memoryOverview = memoryOverview;
global.memoryProfile = function(path) {
    memoryProfile(path);
    return 'Profiled ' + (path ? 'Memory.' + path : 'Memory') + ' to console.';
};

/**
 * Module exports (use when requiring memoryQuery from another module):
 *   query       - alias of memoryQuery
 *   queryKeys   - alias of memoryQueryKeys
 *   queryValues - alias of memoryQueryValues
 *   get         - alias of memoryGet
 *   print       - alias of memoryPrint
 *   overview    - alias of memoryOverview
 *   profile     - alias of memoryProfile
 */
module.exports = {
    query: memoryQuery,
    queryKeys: memoryQueryKeys,
    queryValues: memoryQueryValues,
    get: memoryGet,
    print: memoryPrint,
    overview: memoryOverview,
    profile: memoryProfile
};