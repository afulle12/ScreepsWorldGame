/**
 * memoryQuery.js
 * Utility module to search through Memory for specific terms
 * 
 * Console usage:
 *   memoryQuery('searchTerm')           - Search for term in keys and values
 *   memoryQuery('searchTerm', true)     - Case-sensitive search
 *   memoryQueryKeys('searchTerm')       - Search only in keys
 *   memoryQueryValues('searchTerm')     - Search only in values
 */

const MAX_RESULTS = 100;
const MAX_DEPTH = 20;
const MAX_VALUE_PREVIEW = 100;

/**
 * Recursively search through an object for a term
 * @param {Object} obj - Object to search through
 * @param {string} searchTerm - Term to search for
 * @param {string} currentPath - Current path in the object
 * @param {Array} results - Array to collect results
 * @param {Object} options - Search options
 * @param {number} depth - Current recursion depth
 */
function searchObject(obj, searchTerm, currentPath, results, options, depth) {
    if (depth > MAX_DEPTH) return;
    if (results.length >= MAX_RESULTS) return;
    if (obj === null || obj === undefined) return;

    const searchLower = options.caseSensitive ? searchTerm : searchTerm.toLowerCase();

    if (typeof obj === 'object' && !Array.isArray(obj)) {
        for (const key in obj) {
            if (results.length >= MAX_RESULTS) break;

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
            if (results.length >= MAX_RESULTS) break;

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
 * Main search function
 * @param {string} searchTerm - Term to search for
 * @param {boolean} caseSensitive - Whether search is case-sensitive (default: false)
 * @param {Object} searchOptions - Additional options { searchKeys: true, searchValues: true }
 * @returns {string} Formatted results
 */
function memoryQuery(searchTerm, caseSensitive, searchOptions) {
    if (!searchTerm || typeof searchTerm !== 'string') {
        return 'Usage: memoryQuery("searchTerm", [caseSensitive], [options])';
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
    output += 'Found ' + results.length + ' match' + (results.length === 1 ? '' : 'es');
    if (results.length >= MAX_RESULTS) {
        output += ' (limit reached, there may be more)';
    }
    output += '\n\n';

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
 * Search only in keys
 */
function memoryQueryKeys(searchTerm, caseSensitive) {
    return memoryQuery(searchTerm, caseSensitive, { searchKeys: true, searchValues: false });
}

/**
 * Search only in values
 */
function memoryQueryValues(searchTerm, caseSensitive) {
    return memoryQuery(searchTerm, caseSensitive, { searchKeys: false, searchValues: true });
}

/**
 * Get the value at a specific memory path
 * @param {string} path - Dot-notation path (e.g., "creeps.Scout1.role")
 */
function memoryGet(path) {
    if (!path || typeof path !== 'string') {
        return 'Usage: memoryGet("path.to.value")';
    }

    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let current = Memory;

    for (let i = 0; i < parts.length; i++) {
        if (current === undefined || current === null) {
            return 'Path not found: ' + path + ' (failed at "' + parts[i] + '")';
        }
        current = current[parts[i]];
    }

    console.log('Memory.' + path + ' =', JSON.stringify(current, null, 2));
    return current;
}

/**
 * List all top-level keys in Memory with their types and sizes
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

// Expose to global scope for console access
global.memoryQuery = memoryQuery;
global.memoryQueryKeys = memoryQueryKeys;
global.memoryQueryValues = memoryQueryValues;
global.memoryGet = memoryGet;
global.memoryOverview = memoryOverview;

module.exports = {
    query: memoryQuery,
    queryKeys: memoryQueryKeys,
    queryValues: memoryQueryValues,
    get: memoryGet,
    overview: memoryOverview
};