// 扫 pi 的会话文件，输出 JSON。
// 用法：node scan.js [--limit N] [--root <sessions 目录>]
//
// pi 把会话存在 <root>/<目录slug>/<时间>_<uuid>.jsonl，
// 首行是 {type:"session", id, timestamp, cwd}，所以只读开头就能拿到关键信息，
// 不必把几 MB 的会话全读进来。
const fs = require("fs");
const path = require("path");
const os = require("os");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const LIMIT = Number(flag("--limit", "100")) || 100;
const ROOT = flag("--root", path.join(os.homedir(), ".pi", "agent", "sessions"));

// 流式逐行读，拿到 session 头就继续找第一条用户消息，找到就停。
// 会话文件动辄几 MB，但第一条用户消息一般在前几百 KB 内，所以不会真读完。
function peek(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let rest = "";
    let header = null;
    let total = 0;
    // 最多读 2MB，防异常文件拖着不走。
    while (total < 2 * 1024 * 1024) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (n <= 0) break;
      total += n;
      const text = rest + chunk.subarray(0, n).toString("utf8");
      const lines = text.split("\n");
      // 最后一段可能是半行，留到下一轮拼。
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!header && row.type === "session") {
          header = row;
        } else if (header && row.type === "message" && row.message?.role === "user") {
          const c = row.message.content;
          const txt = String(typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join(" ") : "").replace(/\s+/g, " ").trim();
          // pi 会把扩展清单、系统提示当第一条 user 消息塞进来，跳过它们，
          // 取人真正打的那句。
          if (txt && !/^\[Extensions\]|^\[Context\]|^\[Skills\]|^\[Prompts\]/.test(txt)) {
            header.preview = txt.slice(0, 140);
            return header;
          }
        }
      }
    }
    return header;
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }
}

function walk() {
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(ROOT, d.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      out.push({ file, dir: d.name, mtime: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

const items = walk().sort((a, b) => b.mtime - a.mtime).slice(0, LIMIT);
const sessions = [];
for (const it of items) {
  const header = peek(it.file);
  if (!header?.id) continue;
  sessions.push({
    id: header.id,
    cwd: header.cwd || "",
    folder: (header.cwd || "").split("/").filter(Boolean).pop() || "",
    started: header.timestamp || "",
    mtime: it.mtime,
    size: it.size,
    preview: header.preview || "",
    file: it.file,
  });
}
process.stdout.write(JSON.stringify({ ok: true, count: sessions.length, root: ROOT, sessions }) + "\n");
