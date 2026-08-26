// LLM: Read docs/codex.js before reviewing or changing this file.
// storageBuckets.js
// Console globals: storageOverview, datasetList, datasetInspect
// Example: storageOverview() - Display Heap / Memory / flag / sign storage summary
// Example: datasetList() - List persistent storage bucket datasets
// Example: datasetInspect('datasetId') - Inspect contents of specific dataset bucket
//   heap        - memoryManager.heap (reset-safe caches)
//   serialized  - Memory (active mutable)
//   flag        - flagVault cold snapshots (immutable, FIFO eviction)
//   sign        - reserved storage bucket; permanentRoomFacts uses controller
//                 signs separately from this registry
//   storageOverview()       Heap / Memory / flag / sign summary
//   datasetList()           Registered datasets
//   datasetInspect(id)      Drill into one dataset
const DATASETS = [ {
  id: "marketEconomics",
  owner: "marketEconomics.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.marketEconomics",
  mutability: "mixed",
  notes: "Canonical production-job ledger; closed jobs are first vault candidates"
}, {
  id: "marketEconomics.jobs",
  owner: "marketEconomics.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.marketEconomics.jobs",
  mutability: "mixed",
  notes: "Active mutable jobs plus the recent hot closed window"
}, {
  id: "marketEconomics.closedJobs",
  owner: "marketEconomics.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.marketEconomics.closedOrder",
  mutability: "mutable",
  notes: "Recent hot FIFO; archive removes ids only after verified cold transfer"
}, {
  id: "marketEconomics.archivedJobs",
  owner: "marketEconomics.js",
  bucket: "flag",
  targetBucket: "flag",
  path: null,
  keyPrefix: "me.job.v1:",
  mutability: "readonly",
  notes: "Verified immutable jobs under logical key prefix me.job.v1:"
}, {
  id: "marketEconomics.orderLots",
  owner: "marketEconomics.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.marketEconomics.orderLots",
  mutability: "mutable",
  notes: "FIFO lot ownership; pins some closed jobs in Memory"
}, {
  id: "marketEconomics.settlements",
  owner: "marketEconomics.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.marketEconomics.settlements",
  mutability: "mutable",
  notes: "Compact sale/accounting deltas backed by pinned immutable job snapshots"
}, {
  id: "marketEconomics.settlementBases",
  owner: "marketEconomics.js",
  bucket: "flag",
  targetBucket: "flag",
  path: null,
  keyPrefix: "me.job.base.v1:",
  mutability: "readonly",
  notes: "Pinned production snapshots retained only while their jobs settle"
}, {
  id: "marketEconomics.learning",
  owner: "marketEconomics.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.marketEconomics.learning",
  mutability: "mutable",
  notes: "Phase duration EMA; LEARNING_KEY_CAP=128"
}, {
  id: "lastPlayerAnalysis",
  owner: "scanner.js",
  bucket: "serialized",
  targetBucket: "flag",
  path: "Memory.lastPlayerAnalysis",
  mutability: "readonly",
  notes: "Player analysis report; 10k tick TTL"
}, {
  id: "lastWarEstimate",
  owner: "scanner.js",
  bucket: "serialized",
  targetBucket: "flag",
  path: "Memory.lastWarEstimate",
  mutability: "readonly",
  notes: "War estimate report; 2k tick TTL"
}, {
  id: "roomRegistry",
  owner: "scanner.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.roomRegistry",
  mutability: "mutable",
  notes: "Observer-range room registry"
}, {
  id: "dailyFinance",
  owner: "dailyFinance.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.dailyFinance",
  mutability: "mutable",
  notes: "30-day accounting history"
}, {
  id: "marketHistory.state",
  owner: "marketHistory.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.marketHistory",
  mutability: "mutable",
  notes: "Archive cursor, retention, and cold-write state"
}, {
  id: "marketHistory.transactions",
  owner: "marketHistory.js",
  bucket: "flag",
  targetBucket: "flag",
  path: null,
  keyPrefix: "mh.t1:",
  mutability: "readonly",
  notes: "Compact daily transaction summaries"
}, {
  id: "marketHistory.market",
  owner: "marketHistory.js",
  bucket: "flag",
  targetBucket: "flag",
  path: null,
  keyPrefix: "mh.m1:",
  mutability: "readonly",
  notes: "Compact daily market snapshots for manually tracked resources"
}, {
  id: "flagVault.index",
  owner: "flagVault.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.flagVault.index",
  mutability: "mutable",
  notes: "Logical key → block id map for cold store"
}, {
  id: "flagVault.queue",
  owner: "flagVault.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.flagVault.queue",
  mutability: "ephemeral",
  notes: "In-flight multi-tick put() writes"
}, {
  id: "flagVault.blocks",
  owner: "flagVault.js",
  bucket: "flag",
  targetBucket: "flag",
  path: null,
  mutability: "readonly",
  notes: "Physical __VB1 flag blocks in E4N48"
}, {
  id: "flagVaultTest",
  owner: "flagVault.js",
  bucket: "serialized",
  targetBucket: null,
  path: "Memory.flagVaultTest",
  mutability: "ephemeral",
  notes: "Round-trip test harness state"
}, {
  id: "heap.cpuStats",
  owner: "main.js",
  bucket: "heap",
  targetBucket: "heap",
  path: "heap.cpuStats",
  mutability: "ephemeral",
  notes: "Per-tick CPU telemetry"
}, {
  id: "heap.roomEffProfile",
  owner: "scanner.js",
  bucket: "heap",
  targetBucket: "heap",
  path: "heap.roomEffProfile",
  mutability: "ephemeral",
  notes: "Active 100-tick efficiency profiles"
}, {
  id: "heap.memorySerialization",
  owner: "memoryManager.js",
  bucket: "heap",
  targetBucket: "heap",
  path: "heap.memorySerialization",
  mutability: "ephemeral",
  notes: "Serialization cost samples for scheduler reserve"
} ];
const managedStorage = require("memoryManager").storage;
for (let e = 0; e < DATASETS.length; e++) managedStorage.register(DATASETS[e]);
function getHeap() {
  try {
    return require("memoryManager").heap || {};
  } catch (e) {
    return {};
  }
}

function getFlagVault() {
  try {
    return require("memoryManager").storage.cold;
  } catch (e) {
    return null;
  }
}

function measureSize(e) {
  if (e === undefined) return {
    size: 0,
    missing: true
  };
  try {
    return {
      size: JSON.stringify(e).length,
      missing: false
    };
  } catch (e) {
    return {
      size: 0,
      missing: false,
      error: e && e.message ? e.message : "stringify failed"
    };
  }
}

function formatBytes(e) {
  if (e >= 1024) return (e / 1024).toFixed(2) + " KB";
  return e + " B";
}

function describeValue(e) {
  if (e === null) return "null";
  if (e === undefined) return "undefined";
  if (Array.isArray(e)) return "Array[" + e.length + "]";
  if (typeof e === "object") return "Object{" + Object.keys(e).length + " keys}";
  return typeof e;
}

function heapSummary() {
  const e = getHeap();
  const t = Object.keys(e).sort();
  let a = 0;
  const r = [];
  for (let s = 0; s < t.length; s++) {
    const n = t[s];
    const i = measureSize(e[n]);
    a += i.size;
    r.push({
      key: n,
      size: i.size,
      type: describeValue(e[n]),
      error: i.error || null
    });
  }
  return {
    keys: t.length,
    size: a,
    entries: r
  };
}

function memorySummary() {
  const e = Object.keys(Memory).sort();
  let t = 0;
  const a = [];
  for (let r = 0; r < e.length; r++) {
    const s = e[r];
    const n = measureSize(Memory[s]);
    t += n.size;
    a.push({
      key: s,
      size: n.size,
      type: describeValue(Memory[s]),
      error: n.error || null
    });
  }
  const r = measureSize(Memory);
  return {
    keys: e.length,
    size: r.error ? t : r.size,
    entries: a,
    error: r.error || null
  };
}

function flagSummary() {
  const e = getFlagVault();
  if (!e || typeof e.capacity !== "function") {
    return {
      available: false,
      error: "flagVault unavailable"
    };
  }
  const t = e.capacity();
  const a = typeof e.list === "function" ? e.list() : {
    blocks: [],
    malformedFlags: 0
  };
  return {
    available: true,
    room: t.room,
    usedFlags: t.usedFlags,
    vaultFlags: t.vaultFlags,
    conventional: t.conventional,
    free: t.free,
    maxUsable: t.maxUsable,
    reserve: t.reserve,
    indexKeys: t.indexKeys,
    indexBytes: t.indexBytes,
    queueLength: t.queueLength,
    blocks: a.blocks ? a.blocks.length : 0,
    malformedFlags: a.malformedFlags || 0
  };
}

function datasetById(e) {
  for (let t = 0; t < DATASETS.length; t++) {
    if (DATASETS[t].id === e) return DATASETS[t];
  }
  return null;
}

function measureDataset(e) {
  const t = {
    id: e.id,
    owner: e.owner,
    bucket: e.bucket,
    targetBucket: e.targetBucket,
    path: e.path,
    mutability: e.mutability,
    notes: e.notes,
    present: false,
    size: 0,
    type: null,
    extra: null
  };
  if (e.bucket === "flag" && e.id === "flagVault.blocks") {
    const e = flagSummary();
    t.present = !!e.available;
    t.size = e.indexBytes || 0;
    t.type = e.available ? "blocks=" + e.blocks + " vaultFlags=" + e.vaultFlags : "unavailable";
    t.extra = e;
    return t;
  }
  if (e.bucket === "flag" && e.keyPrefix) {
    const a = getFlagVault();
    if (!a) {
      t.type = "unavailable";
      return t;
    }
    const r = a.keys().filter(function(t) {
      return t.indexOf(e.keyPrefix) === 0;
    });
    let s = 0;
    let n = 0;
    for (let e = 0; e < r.length; e++) {
      const t = a.meta(r[e]);
      if (!t) continue;
      s += t.bytes || 0;
      n += t.flags || 0;
    }
    t.present = r.length > 0;
    t.size = s;
    t.type = "records=" + r.length + " flags=" + n;
    t.extra = {
      keyPrefix: e.keyPrefix,
      keys: r.length,
      bytes: s,
      flags: n
    };
    return t;
  }
  if (!e.path) {
    t.type = "n/a";
    return t;
  }
  let a;
  try {
    a = managedStorage.get(e.id);
  } catch (e) {
    t.type = "error";
    t.extra = {
      error: e && e.message ? e.message : String(e)
    };
    return t;
  }
  if (a === undefined) {
    t.type = "missing";
    return t;
  }
  const r = measureSize(a);
  t.present = true;
  t.size = r.size;
  t.type = describeValue(a);
  if (r.error) t.extra = {
    error: r.error
  };
  return t;
}

function storageOverview() {
  const e = heapSummary();
  const t = memorySummary();
  const a = flagSummary();
  const r = [];
  r.push("=== Storage Overview ===");
  r.push("");
  r.push("Bucket          Size / occupancy");
  r.push("--------------  --------------------------------------------------");
  r.push("heap            " + formatBytes(e.size) + "  (" + e.keys + " keys)");
  r.push("serialized      " + formatBytes(t.size) + "  (" + t.keys + " top-level keys)" + (t.error ? "  [stringify error]" : ""));
  if (a.available) {
    r.push("flag            free=" + a.free + "/" + a.maxUsable + "  used=" + a.usedFlags + "  vault=" + a.vaultFlags + "  conventional=" + a.conventional + "  index=" + a.indexKeys + "  queue=" + a.queueLength + "  room=" + a.room);
    r.push("                indexBytes≈" + formatBytes(a.indexBytes || 0) + "  blocks=" + a.blocks + (a.malformedFlags ? "  malformed=" + a.malformedFlags : ""));
  } else {
    r.push("flag            unavailable" + (a.error ? " (" + a.error + ")" : ""));
  }
  r.push("sign            not implemented");
  r.push("");
  r.push("Registered datasets: " + DATASETS.length + "  (datasetList() / datasetInspect(id))");
  const s = {};
  for (let e = 0; e < DATASETS.length; e++) {
    const t = DATASETS[e].path;
    if (t && t.indexOf("Memory.") === 0) {
      const e = t.slice(7).split(".")[0];
      s[e] = true;
    }
  }
  const n = [];
  for (let e = 0; e < t.entries.length; e++) {
    if (!s[t.entries[e].key]) n.push(t.entries[e]);
  }
  n.sort(function(e, t) {
    return t.size - e.size;
  });
  if (n.length) {
    r.push("");
    r.push("Largest unregistered Memory keys (top 10):");
    for (let e = 0; e < n.length && e < 10; e++) {
      const t = n[e];
      r.push("  " + t.key.padEnd(28) + formatBytes(t.size).padStart(10) + "  " + t.type);
    }
  }
  const i = r.join("\n");
  console.log(i);
  return i;
}

function datasetList() {
  const e = [];
  e.push("=== Dataset Registry ===");
  e.push("id".padEnd(30) + "bucket".padEnd(12) + "target".padEnd(10) + "size".padStart(10) + "  mutability");
  e.push("-".repeat(78));
  const t = DATASETS.map(measureDataset);
  t.sort(function(e, t) {
    if (e.bucket !== t.bucket) return e.bucket.localeCompare(t.bucket);
    return e.id.localeCompare(t.id);
  });
  for (let a = 0; a < t.length; a++) {
    const r = t[a];
    const s = r.present ? formatBytes(r.size) : r.type === "missing" ? "—" : formatBytes(r.size);
    e.push(r.id.padEnd(30) + r.bucket.padEnd(12) + (r.targetBucket || "—").padEnd(10) + s.padStart(10) + "  " + r.mutability);
  }
  const a = e.join("\n");
  console.log(a);
  return a;
}

function datasetInspect(e) {
  if (!e || typeof e !== "string") {
    const e = 'Usage: datasetInspect("marketEconomics.closedJobs")';
    console.log(e);
    return e;
  }
  const t = datasetById(e);
  if (!t) {
    const t = "Unknown dataset: " + e + "\nKnown: " + DATASETS.map(function(e) {
      return e.id;
    }).join(", ");
    console.log(t);
    return t;
  }
  const a = measureDataset(t);
  const r = [];
  r.push("=== Dataset: " + t.id + " ===");
  r.push("owner:        " + t.owner);
  r.push("bucket:       " + t.bucket + (t.targetBucket ? " → target " + t.targetBucket : ""));
  r.push("path:         " + (t.path || "(none)"));
  r.push("mutability:   " + t.mutability);
  r.push("notes:        " + t.notes);
  r.push("present:      " + a.present);
  r.push("size:         " + (a.present ? formatBytes(a.size) : a.type));
  r.push("type:         " + (a.type || "—"));
  if (t.path) {
    let e;
    try {
      e = managedStorage.get(t.id);
    } catch (t) {
      e = undefined;
    }
    if (e && typeof e === "object") {
      if (Array.isArray(e)) {
        r.push("length:       " + e.length);
        const t = e.slice(0, 8);
        r.push("sample:       " + JSON.stringify(t));
      } else {
        const a = Object.keys(e).sort();
        r.push("keys:         " + a.length);
        if (a.length && a.length <= 40) {
          r.push("key list:     " + a.join(", "));
        } else if (a.length) {
          r.push("key sample:   " + a.slice(0, 20).join(", ") + " …");
        }
        if (t.id === "marketEconomics.jobs") {
          let t = 0;
          let s = 0;
          let n = 0;
          for (let r = 0; r < a.length; r++) {
            const i = e[a[r]];
            const o = i && i.status;
            if (o === "active" || o === "selling") t++; else if (o === "done" || o === "failed" || o === "cancelled") s++; else n++;
          }
          r.push("job status:   active/selling=" + t + " closed=" + s + " other=" + n);
        }
      }
    }
  }
  if (t.bucket === "flag" || t.targetBucket === "flag") {
    const e = getFlagVault();
    if (e) {
      const t = e.capacity();
      r.push("flag free:    " + t.free + "/" + t.maxUsable);
      r.push("flag index:   " + t.indexKeys + " keys, ≈" + formatBytes(t.indexBytes || 0));
      if (typeof e.keys === "function") {
        const t = e.keys();
        r.push("vault keys:   " + (t.length ? t.join(", ") : "(none)"));
      }
    }
  }
  if (a.extra) {
    r.push("extra:        " + JSON.stringify(a.extra));
  }
  const s = r.join("\n");
  console.log(s);
  return s;
}

function listDatasets() {
  return DATASETS.slice();
}

const api = {
  DATASETS: DATASETS,
  listDatasets: listDatasets,
  storageOverview: storageOverview,
  datasetList: datasetList,
  datasetInspect: datasetInspect,
  measureDataset: measureDataset,
  heapSummary: heapSummary,
  memorySummary: memorySummary,
  flagSummary: flagSummary
};
global.storageOverview = function() {
  storageOverview();
  return "Storage overview printed.";
};
global.datasetList = function() {
  datasetList();
  return "Dataset registry printed.";
};
global.datasetInspect = function(e) {
  datasetInspect(e);
  return "Dataset inspection printed.";
};
module.exports = api;
