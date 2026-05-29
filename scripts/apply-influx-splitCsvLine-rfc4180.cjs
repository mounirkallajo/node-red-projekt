"use strict";

/**
 * Ersetzt die naive splitCsvLine-Implementierung in allen Function-Nodes (flows.json),
 * damit CSV-Zellen mit Kommas (z. B. points_json) korrekt geparst werden.
 */
const fs = require("fs");
const path = require("path");

const flowPath = path.join(__dirname, "..", "flows.json");

const OLD_SPLIT =
    "function splitCsvLine(line) {\n" +
    "    const out = [];\n" +
    '    let cur = "";\n' +
    "    let inQuotes = false;\n" +
    "    for (let i = 0; i < line.length; i++) {\n" +
    "        const c = line[i];\n" +
    '        if (c === \'"\') {\n' +
    "            inQuotes = !inQuotes;\n" +
    "            continue;\n" +
    "        }\n" +
    '        if (c === "," && !inQuotes) {\n' +
    "            out.push(cur);\n" +
    '            cur = "";\n' +
    "            continue;\n" +
    "        }\n" +
    "        cur += c;\n" +
    "    }\n" +
    "    out.push(cur);\n" +
    "    return out;\n" +
    "}";

const NEW_SPLIT =
    "function splitCsvLine(line) {\n" +
    "    const out = [];\n" +
    '    let cur = "";\n' +
    "    let i = 0;\n" +
    "    while (i < line.length) {\n" +
    "        const c = line[i];\n" +
    '        if (c === \'"\') {\n' +
    "            i++;\n" +
    "            while (i < line.length) {\n" +
    '                if (line[i] === \'"\') {\n' +
    "                    if (i + 1 < line.length && line[i + 1] === '\"') {\n" +
    "                        cur += '\"';\n" +
    "                        i += 2;\n" +
    "                    } else {\n" +
    "                        i++;\n" +
    "                        break;\n" +
    "                    }\n" +
    "                } else {\n" +
    "                    cur += line[i];\n" +
    "                    i++;\n" +
    "                }\n" +
    "            }\n" +
    "            continue;\n" +
    "        }\n" +
    '        if (c === ",") {\n' +
    "            out.push(cur);\n" +
    '            cur = "";\n' +
    "            i++;\n" +
    "            continue;\n" +
    "        }\n" +
    "        cur += c;\n" +
    "        i++;\n" +
    "    }\n" +
    "    out.push(cur);\n" +
    "    return out;\n" +
    "}";

function main() {
    const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
    let count = 0;
    for (let ni = 0; ni < flow.length; ni++) {
        const n = flow[ni];
        if (n.type !== "function" || typeof n.func !== "string") {
            continue;
        }
        if (!n.func.includes("inQuotes = !inQuotes")) {
            continue;
        }
        if (!n.func.includes(OLD_SPLIT)) {
            continue;
        }
        n.func = n.func.split(OLD_SPLIT).join(NEW_SPLIT);
        count++;
    }
    if (count === 0) {
        throw new Error("apply-influx-splitCsvLine-rfc4180: no matching function nodes (already patched?)");
    }
    fs.writeFileSync(flowPath, JSON.stringify(flow));
    JSON.parse(fs.readFileSync(flowPath, "utf8"));
    console.log("OK: splitCsvLine RFC4180 applied in", count, "function node(s).");
}

main();
