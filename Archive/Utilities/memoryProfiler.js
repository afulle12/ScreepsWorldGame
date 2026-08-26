// =================================================================
// === MEMORY PROFILER =============================================
// =================================================================
// Usage (after main integration):
//   memoryProfile()                 // profile top-level Memory keys
//   memoryProfile('creeps')         // profile Memory.creeps subtree
//   memoryProfile('rooms.W1N1')     // profile Memory.rooms.W1N1 subtree
//
// Size is approximate: length of JSON.stringify(value).
// Output format (tab-separated, similar to CPU reports), emitted as a
// single console.log() call so it’s one contiguous block:
//   size    percent     key
//
// Also includes:
//   Memory serialization CPU (JSON.stringify(Memory)): <cpu>
// =================================================================

function _getSize(value) {
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

    var info = _getSize(obj[key]);
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

  // Sort by size descending
  entries.sort(function(a, b) {
    return b.size - a.size;
  });

  var lines = [];

  // Header
  lines.push("size\tpercent\tkey (" + label + ".*)");

  // Rows
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var pct = total > 0 ? (entry.size / total * 100) : 0;

    lines.push(
      entry.size + "\t" +
      pct.toFixed(2) + "\t" +
      label + "." + entry.key
    );
  }

  // Summary / total line
  lines.push(
    "Total:\t" +
    total + "\t" +
    "100.00\t" +
    label
  );

  // Serialization CPU footer
  if (typeof serializationCpu === 'number') {
    lines.push("");
    lines.push(
      "Memory serialization CPU (JSON.stringify(Memory)): " +
      serializationCpu.toFixed(3)
    );
  }

  // Emit as a single console entry
  console.log(lines.join('\n'));
}

/**
 * Profile Memory or a subtree.
 *
 * @param {string} [path] - Optional dot-separated path under Memory.
 *   - undefined / empty: profiles top-level Memory
 *   - "creeps": profiles Memory.creeps
 *   - "rooms.W1N1": profiles Memory.rooms.W1N1
 *
 * Logs a single multi-line block to console and does not return entries.
 */
function profile(path) {
  // Determine memory serialization load once per call
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

  // If this is not an object, just report its size directly
  if (node === null || typeof node !== 'object') {
    var info = _getSize(node);
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

module.exports = {
  profile: profile
};
