// marketMap
// Console-only market liquidity snapshot. Groups active market orders by room.
// Usage: type marketMap() in the Screeps console.

const ACCOUNT_RESOURCES = new Set([
    SUBSCRIPTION_TOKEN,
    CPU_UNLOCK,
    PIXEL,
    ACCESS_KEY
].filter(Boolean));

function formatInt(n) {
    n = Math.floor(n);
    const negative = n < 0;
    const abs = Math.abs(n).toString();
    const parts = [];
    for (let i = abs.length; i > 0; i -= 3) {
        parts.unshift(abs.slice(Math.max(0, i - 3), i));
    }
    return (negative ? "-" : "") + parts.join(",");
}

function fmtNet(n) {
    return (n >= 0 ? "+" : "") + formatInt(n);
}

function padL(str, width) {
    const s = String(str);
    return " ".repeat(Math.max(0, width - s.length)) + s;
}

function padR(str, width) {
    const s = String(str);
    return s + " ".repeat(Math.max(0, width - s.length));
}

function marketMap() {
    const orders = Game.market.getAllOrders();
    const rooms = {};
    let skipped = 0;

    for (const o of orders) {
        // Skip explicitly inactive orders only.
        // Do NOT use if (!o.active) here because getAllOrders may omit the field.
        if (o.active === false) {
            skipped++;
            continue;
        }
        if (ACCOUNT_RESOURCES.has(o.resourceType)) continue;
        if (!o.roomName) continue;

        if (!rooms[o.roomName]) {
            rooms[o.roomName] = { sells: 0, buys: 0, sellRes: {}, buyRes: {} };
        }
        const entry = rooms[o.roomName];
        const value = o.price * o.remainingAmount;

        if (o.type === ORDER_SELL) {
            entry.sells += value;
            entry.sellRes[o.resourceType] = (entry.sellRes[o.resourceType] || 0) + value;
        } else {
            entry.buys += value;
            entry.buyRes[o.resourceType] = (entry.buyRes[o.resourceType] || 0) + value;
        }
    }

    const rows = [];
    for (const roomName in rooms) {
        const r = rooms[roomName];
        const total = r.sells + r.buys;
        if (total === 0) continue;

        const net = r.sells - r.buys;
        const allRes = new Set([...Object.keys(r.sellRes), ...Object.keys(r.buyRes)]);
        const resTags = [...allRes].sort().map(res => {
            const hasSell = r.sellRes[res] > 0;
            const hasBuy = r.buyRes[res] > 0;
            if (hasSell && hasBuy) return `${res}(B)`;
            if (hasSell) return `${res}(^)`;
            return `${res}(v)`;
        }).join(" ");

        rows.push({ room: roomName, sells: r.sells, buys: r.buys, net, total, resources: resTags });
    }

    rows.sort((a, b) => b.total - a.total);

    const wRoom = Math.max(4, ...rows.map(r => r.room.length), 4);
    const wSell = Math.max(5, ...rows.map(r => formatInt(r.sells).length), 5);
    const wBuy = Math.max(4, ...rows.map(r => formatInt(r.buys).length), 4);
    const wNet = Math.max(3, ...rows.map(r => fmtNet(r.net).length), 3);

    const lines = [];
    const header = `${padR("Room", wRoom)} | ${padL("Sells", wSell)} | ${padL("Buys", wBuy)} | ${padL("Net", wNet)} | Resources`;
    lines.push(header);
    lines.push("-".repeat(header.length));

    for (const r of rows) {
        const line = `${padR(r.room, wRoom)} | ${padL(formatInt(r.sells), wSell)} | ${padL(formatInt(r.buys), wBuy)} | ${padL(fmtNet(r.net), wNet)} | ${r.resources}`;
        lines.push(line);
    }

    console.log(lines.join("\n"));
    if (rows.length === 0) {
        console.log(`[marketMap] No rooms mapped. Total orders scanned: ${orders.length}. Skipped inactive: ${skipped}`);
    }
    return `${rows.length} rooms mapped`;
}

global.marketMap = marketMap;
module.exports = marketMap;
