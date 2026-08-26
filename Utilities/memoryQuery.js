// LLM: Read docs/codex.js before reviewing or changing this file.
// memoryQuery.js
// Console globals: memoryQuery, memoryGet, memoryProfile, memoryOverview, memoryPrint, memoryQueryKeys, memoryQueryValues
// Example: memoryQuery('rooms.E1N1') - Inspect specific path in Memory
// Example: memoryGet('rooms.E1N1.defcon') - Retrieve raw value at memory path
// Example: memoryProfile() - Profile memory segment and key sizes
// Example: memoryOverview() - Print high-level memory usage summary
// Example: memoryPrint('rooms.E1N1') - Pretty-print memory branch
// Example: memoryQueryKeys('rooms') - List keys under memory path
// Example: memoryQueryValues('rooms.E1N1') - List key-value pairs under memory path
/**
 * memoryQuery.js -- search through Memory and print Memory sub-trees.
 *
 * CONSOLE USAGE
 *   memoryQuery() / memoryQuery('help')  Print help with examples.
 *   memoryQuery('searchTerm')            Search term in keys and values.
 *   memoryQuery('searchTerm', true)      Case-sensitive search.
 *   memoryQuery('creeps')                Print Memory.creeps as JSON.
 *   memoryQuery('Memory.rooms.W1N1')     Print a sub-tree (Memory. prefix optional).
 *   memoryQuery('rooms.W1N1.sources[0]') Array indices supported.
 *   memoryQueryKeys/memoryQueryValues('searchTerm')  Search only keys / only values.
 *   memoryGet('creeps.MyCreep.role')     Get and print a single value.
 *   memoryPrint('creeps')                Force print mode (never searches).
 *   memoryOverview()                     List top-level Memory keys with sizes.
 *   e.g. memoryQuery('harvester'); memoryQuery('harvester', true);
 *   memoryQuery('Memory.creeps'); memoryQuery('rooms.W1N1.sources[0]');
 *   memoryPrint('creeps.MyCreep.role'); memoryGet(...) is an alias of memoryPrint.
 *
 * Return values: memoryQuery/memoryPrint -> "Printed Memory.<path> to
 * console." (or "No matches found for ...", "Path not found: ...", or a
 * count summary depending on the call); memoryGet -> the resolved value
 * itself; memoryQueryKeys/memoryQueryValues -> count summary like
 * memoryQuery; memoryOverview -> "See console for Memory overview.";
 * memoryQuery()/memoryQuery('help') -> prints the help block.
 *
 * Path syntax: dot-notation with an optional "Memory." prefix; array
 * indices use bracketed form, e.g. rooms.W1N1.sources[0].
 *
 * Search returns every match (no result cap); only a depth limit
 * (MAX_DEPTH) guards against cyclic structures.
 */
const MAX_DEPTH = 20;
const MAX_VALUE_PREVIEW = 100;
const HELP_TEXT = "=== memoryQuery help ===\n" + "Search Memory or print a Memory sub-tree as JSON.\n\n" + "Functions:\n" + "  memoryQuery(term, [caseSensitive], [options]) - search or print path\n" + "  memoryQueryKeys(term, [caseSensitive])        - search keys only\n" + "  memoryQueryValues(term, [caseSensitive])      - search values only\n" + "  memoryGet(path)                               - get + print a Memory value\n" + "  memoryPrint(path)                             - force-print a Memory path\n" + "  memoryOverview()                              - list top-level Memory keys\n\n" + "Returns:\n" + '  search mode  -> "Found N match(es). See console for details."\n' + '  path mode    -> "Printed Memory.<path> to console."\n' + "  memoryGet    -> returns the actual value (not a string)\n\n" + "Path syntax:\n" + "  dot-notation with optional Memory. prefix\n" + "  array indices via [n], e.g. rooms.W1N1.sources[0]\n\n" + "Examples:\n" + "  memoryQuery()\n" + '  memoryQuery("harvester")             // search keys + values\n' + '  memoryQuery("harvester", true)       // case-sensitive search\n' + '  memoryQuery("creeps")                // print Memory.creeps\n' + '  memoryQuery("Memory.rooms.W1N1")     // accept Memory. prefix\n' + '  memoryQuery("rooms.W1N1.sources[0]") // array index support\n' + '  memoryPrint("creeps.MyCreep.role")   // print one field\n' + "  memoryOverview()                     // show top-level keys + sizes\n";
function searchObject(e, r, o, t, n, s) {
  if (s > MAX_DEPTH) return;
  if (e === null || e === undefined) return;
  const i = n.caseSensitive ? r : r.toLowerCase();
  if (typeof e === "object" && !Array.isArray(e)) {
    for (const a in e) {
      const y = o ? o + "." + a : a;
      const u = n.caseSensitive ? a : a.toLowerCase();
      if (n.searchKeys && u.includes(i)) {
        t.push({
          path: "Memory." + y,
          matchType: "key",
          key: a,
          valuePreview: getValuePreview(e[a])
        });
      }
      if (n.searchValues && isPrimitive(e[a])) {
        const r = String(e[a]);
        const o = n.caseSensitive ? r : r.toLowerCase();
        if (o.includes(i)) {
          t.push({
            path: "Memory." + y,
            matchType: "value",
            key: a,
            value: r.substring(0, MAX_VALUE_PREVIEW)
          });
        }
      }
      if (typeof e[a] === "object" && e[a] !== null) {
        searchObject(e[a], r, y, t, n, s + 1);
      }
    }
  } else if (Array.isArray(e)) {
    for (let a = 0; a < e.length; a++) {
      const y = o + "[" + a + "]";
      if (n.searchValues && isPrimitive(e[a])) {
        const r = String(e[a]);
        const o = n.caseSensitive ? r : r.toLowerCase();
        if (o.includes(i)) {
          t.push({
            path: "Memory." + y,
            matchType: "value",
            key: "[" + a + "]",
            value: r.substring(0, MAX_VALUE_PREVIEW)
          });
        }
      }
      if (typeof e[a] === "object" && e[a] !== null) {
        searchObject(e[a], r, y, t, n, s + 1);
      }
    }
  }
}

function isPrimitive(e) {
  return e === null || typeof e !== "object" && typeof e !== "function";
}

function parseMemoryPath(e) {
  if (!e || typeof e !== "string") return null;
  let r = e.trim();
  if (r.length === 0) return null;
  if (r.toLowerCase().indexOf("memory.") === 0) r = r.substring(7);
  if (r.length === 0) return null;
  const o = r.replace(/\[(\d+)\]/g, ".$1").split(".");
  for (let e = 0; e < o.length; e++) {
    if (o[e] === "") return null;
  }
  return o;
}

function resolveMemoryPath(e) {
  const r = parseMemoryPath(e);
  if (!r) return {
    found: false,
    value: undefined,
    path: e
  };
  let o = Memory;
  for (let t = 0; t < r.length; t++) {
    if (o === null || o === undefined) {
      return {
        found: false,
        value: undefined,
        path: e,
        failedAt: r[t]
      };
    }
    o = o[r[t]];
  }
  return {
    found: o !== undefined,
    value: o,
    path: e
  };
}

function formatValueForPrint(e) {
  try {
    return JSON.stringify(e, null, 2);
  } catch (r) {
    return String(e);
  }
}

function printMemoryPath(e) {
  const r = resolveMemoryPath(e);
  if (!r.found) {
    return "Path not found: " + r.path;
  }
  const o = r.path.toLowerCase().indexOf("memory.") === 0 ? r.path : "Memory." + r.path;
  console.log(o + " =\n" + formatValueForPrint(r.value));
  return "Printed " + o + " to console.";
}

function getValuePreview(e) {
  if (e === null) return "null";
  if (e === undefined) return "undefined";
  if (typeof e === "object") {
    if (Array.isArray(e)) {
      return "[Array(" + e.length + ")]";
    }
    const r = Object.keys(e);
    if (r.length <= 3) {
      return "{" + r.join(", ") + "}";
    }
    return "{" + r.slice(0, 3).join(", ") + ", ... +" + (r.length - 3) + " more}";
  }
  const r = String(e);
  return r.length > MAX_VALUE_PREVIEW ? r.substring(0, MAX_VALUE_PREVIEW) + "..." : r;
}

function memoryQuery(e, r, o) {
  if (!e || typeof e !== "string") {
    console.log(HELP_TEXT);
    return "See console for memoryQuery usage and examples.";
  }
  if (typeof e === "string" && e.toLowerCase() === "help") {
    console.log(HELP_TEXT);
    return "See console for memoryQuery usage and examples.";
  }
  if (parseMemoryPath(e)) {
    const r = resolveMemoryPath(e);
    if (r.found) {
      return printMemoryPath(e);
    }
  }
  const t = {
    caseSensitive: r || false,
    searchKeys: true,
    searchValues: true
  };
  if (o) {
    if (o.searchKeys !== undefined) t.searchKeys = o.searchKeys;
    if (o.searchValues !== undefined) t.searchValues = o.searchValues;
  }
  const n = [];
  searchObject(Memory, e, "", n, t, 0);
  if (n.length === 0) {
    return 'No matches found for "' + e + '"';
  }
  let s = '=== Memory Search Results for "' + e + '" ===\n';
  s += "Found " + n.length + " match" + (n.length === 1 ? "" : "es") + "\n\n";
  for (let e = 0; e < n.length; e++) {
    const r = n[e];
    if (r.matchType === "key") {
      s += "[KEY]   " + r.path + "\n";
      s += "        Preview: " + r.valuePreview + "\n";
    } else {
      s += "[VALUE] " + r.path + "\n";
      s += "        Value: " + r.value + "\n";
    }
  }
  console.log(s);
  return "Found " + n.length + " match(es). See console for details.";
}

function memoryQueryKeys(e, r) {
  return memoryQuery(e, r, {
    searchKeys: true,
    searchValues: false
  });
}

function memoryQueryValues(e, r) {
  return memoryQuery(e, r, {
    searchKeys: false,
    searchValues: true
  });
}

function memoryGet(e) {
  if (!e || typeof e !== "string") {
    return 'Usage: memoryGet("path.to.value")';
  }
  const r = resolveMemoryPath(e);
  if (!r.found) {
    return "Path not found: " + e;
  }
  const o = e.toLowerCase().indexOf("memory.") === 0 ? e : "Memory." + e;
  console.log(o + " =\n" + formatValueForPrint(r.value));
  return r.value;
}

function memoryPrint(e) {
  if (!e || typeof e !== "string") {
    return 'Usage: memoryPrint("path.to.value")';
  }
  if (!parseMemoryPath(e)) {
    return "Invalid path: " + e;
  }
  return printMemoryPath(e);
}

function memoryOverview() {
  let e = "=== Memory Overview ===\n";
  const r = JSON.stringify(Memory).length;
  e += "Total Memory Size: " + (r / 1024).toFixed(2) + " KB\n\n";
  const o = Object.keys(Memory).sort();
  for (let r = 0; r < o.length; r++) {
    const t = o[r];
    const n = Memory[t];
    const s = JSON.stringify(n).length;
    const i = s > 1024 ? (s / 1024).toFixed(2) + " KB" : s + " B";
    let a;
    if (n === null) {
      a = "null";
    } else if (Array.isArray(n)) {
      a = "Array[" + n.length + "]";
    } else if (typeof n === "object") {
      a = "Object{" + Object.keys(n).length + " keys}";
    } else {
      a = typeof n;
    }
    e += "  " + t.padEnd(25) + " " + a.padEnd(20) + " " + i + "\n";
  }
  console.log(e);
  return "See console for Memory overview.";
}

var memoryManager = require("memoryManager");
function _profileGetSize(e) {
  var r;
  try {
    r = JSON.stringify(e);
  } catch (e) {
    return {
      size: 0,
      error: e && e.message ? e.message : "stringify failed"
    };
  }
  return {
    size: r.length
  };
}

function _profileObject(e, r, o) {
  var t = 0;
  var n = [];
  for (var s in e) {
    if (!Object.prototype.hasOwnProperty.call(e, s)) {
      continue;
    }
    var i = _profileGetSize(e[s]);
    var a = i.size;
    t += a;
    n.push({
      key: s,
      size: a
    });
  }
  if (n.length === 0) {
    var y = "No enumerable keys under " + r;
    if (typeof o === "number") {
      y += "\nMemory serialization CPU (JSON.stringify(Memory)): " + o.toFixed(3);
    }
    console.log(y);
    return;
  }
  n.sort(function(e, r) {
    return r.size - e.size;
  });
  var u = [];
  u.push("size\tpercent\tkey (" + r + ".*)");
  for (var l = 0; l < n.length; l++) {
    var m = n[l];
    var f = t > 0 ? m.size / t * 100 : 0;
    u.push(m.size + "\t" + f.toFixed(2) + "\t" + r + "." + m.key);
  }
  u.push("Total:\t" + t + "\t" + "100.00\t" + r);
  if (typeof o === "number") {
    u.push("");
    u.push("Memory serialization CPU (JSON.stringify(Memory)): " + o.toFixed(3));
  }
  console.log(u.join("\n"));
}

function memoryProfile(e) {
  var r = Game.cpu.getUsed();
  JSON.stringify(Memory);
  var o = Game.cpu.getUsed() - r;
  memoryManager.recordSerializationCost(o);
  if (!e) {
    _profileObject(Memory, "Memory", o);
    return;
  }
  var t = e.split(".");
  var n = Memory;
  var s = "Memory";
  for (var i = 0; i < t.length; i++) {
    var a = t[i];
    if (typeof n[a] === "undefined") {
      var y = [];
      y.push("Path not found in Memory: " + s + "." + a);
      y.push("Memory serialization CPU (JSON.stringify(Memory)): " + o.toFixed(3));
      console.log(y.join("\n"));
      return;
    }
    n = n[a];
    s += "." + a;
  }
  if (n === null || typeof n !== "object") {
    var u = _profileGetSize(n);
    var l = [];
    l.push("size\tpercent\tkey");
    l.push(u.size + "\t100.00\t" + s);
    l.push("");
    l.push("Memory serialization CPU (JSON.stringify(Memory)): " + o.toFixed(3));
    console.log(l.join("\n"));
    return;
  }
  _profileObject(n, s, o);
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
 */ global.memoryQuery = memoryQuery;
global.memoryQueryKeys = memoryQueryKeys;
global.memoryQueryValues = memoryQueryValues;
global.memoryGet = memoryGet;
global.memoryPrint = memoryPrint;
global.memoryOverview = memoryOverview;
global.memoryProfile = function(e) {
  memoryProfile(e);
  return "Profiled " + (e ? "Memory." + e : "Memory") + " to console.";
};
module.exports = {
  query: memoryQuery,
  queryKeys: memoryQueryKeys,
  queryValues: memoryQueryValues,
  get: memoryGet,
  print: memoryPrint,
  overview: memoryOverview,
  profile: memoryProfile
};
