// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { FOR_EXT, FOR_NAME, FOR_DIR, FILE, FOLDER, FOLDER_OPEN } from "./icons-map.js";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, props, openOverlay, closeOverlay, notify, nextCommand, setShared } from "herdr";

// 用 VS Code / Zed / 系统文件窗口打开一个目录。远程机器要查 ssh 别名（空间的
// machine 是显示名，用户改过大小写就可能和 ssh Host 对不上）。和 abs/parts/lib.js
// 同一份逻辑，mod 之间不跨目录 import，各自带。
function openInEditor(app, dir, on) {
  if (!dir) return;
  const platform = window()?.platform;
  const list = platform === "macos"
    ? [["vscode", "VS Code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"], ["zed", "Zed", "/Applications/Zed.app/Contents/MacOS/cli"], ["files", "文件窗口", "open"]]
    : platform === "windows"
      ? [["vscode", "VS Code", "code"], ["zed", "Zed", "zed"], ["files", "文件窗口", "explorer.exe"]]
      : [["vscode", "VS Code", "code"], ["zed", "Zed", "zed"], ["files", "文件窗口", "xdg-open"]];
  const e = list.find((x) => x[0] === app) ?? list[0];
  if (app !== "files") setShared("studio.editor", e[0]);
  const fail = (err) => notify({ title: `打不开 ${e[1]}${on ? `（${on}）` : ""}`, body: String(err && (err.stderr || err.message || err)).split("\n")[0] || "没装？", level: "error" });
  if (e[0] === "files") { exec(e[2], [dir], on ? { on } : undefined).catch(fail); return; }
  if (!on) { exec(e[2], [dir]).catch(fail); return; }
  // 查 ssh Host 的 awk：k 是机器名，大小写不敏感
  const k = String(on).replace(/'/g, "");
  const host = `$(awk -v k='${k}' 'tolower($1)=="host"{for(i=2;i<=NF;i++) if(tolower($i)==k){print $i; exit}}' "$HOME/.ssh/config" 2>/dev/null)`;
  const script = e[0] === "zed"
    ? `exec "${e[2]}" "ssh://\${host:-${on}}'${dir}'"`
    : `exec "${e[2]}" --remote "ssh-remote+\${host:-${on}}" '${dir}'`;
  exec("sh", ["-c", script]).catch(fail);
}

// 远程写文件：writeTextFile 只管本机；远程走 sh + heredoc（base64 在部分机器上被拒）。
async function shellWrite(path, text, on) {
  const d = "FV_EOF_" + Math.random().toString(36).slice(2, 10);
  // 先写同目录临时文件再 mv：中途断连不会留下半截文件（mv 同盘是原子的）。
  // heredoc 结束行后面用 ; 接命令，不能用换行后的 &&（那会被当成新命令，语法错误）。
  const r = await exec("sh", ["-c", `t="$1.tmp.$$"; cat > "$t" <<'${d}'\n${text}\n${d}\nrc=$?; if [ "$rc" -eq 0 ]; then mv -f "$t" "$1"; else rm -f "$t"; fi; exit $rc`, "fv-write", path], { on });
  if (!r || r.code !== 0) throw new Error((r?.stderr || "写入失败").trim().slice(0, 120) || "写入失败");
}

// The panels share data in one VM, but their host tasks belong to separate copies.
const scans = globalThis[Symbol.for("herdr.repoStatus.v2")] ??= new Map();

async function repoStatus(root, on, { after, visiting, urgent, allowInactive }, cx, current) {
  const repo = JSON.stringify([on, root]), now = Date.now();
  for (const [key, scan] of scans) {
    if (scan.pollAt <= now || (!scan.pollAt && scan.task.is_done())) scans.delete(key);
  }
  while (current()) {
    let scan = scans.get(repo);
    const pending = scan && !scan.pollAt && !scan.task.is_done();
    const reusable = scan?.status?.code === 0 && Date.now() < scan.pollAt
      && (scan.started >= after || (!urgent && Date.now() < scan.watchAt));
    if (!reusable && (!pending || (visiting && scan.started !== undefined && scan.started < after))) {
      if (!allowInactive && window()?.active === false) return null;
      const next = {};
      next.task = cx.spawn(async cx => {
        await cx.sleep(25); // Let both listeners for a watch batch join before starting Git.
        if (!allowInactive && window()?.active === false) return;
        next.started = Date.now();
        try {
          next.status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on });
        } catch (error) {
          next.error = error;
        } finally {
          const finished = Date.now(), duration = finished - next.started;
          const delay = duration < 500 ? 0 : Math.min(60000, 5 * duration);
          next.watchAt = finished + delay;
          next.pollAt = finished + Math.max(10000, delay);
          if (next.status?.code !== 0 && scans.get(repo) === next) scans.delete(repo);
        }
      });
      scans.set(repo, next);
      scan = next;
    }
    // Resume through our own host task, so another copy's close cannot cancel our follow-up work.
    while (current() && !scan.pollAt && !scan.task.is_done()) await cx.sleep(50);
    if (!current()) return null;
    if (!scan.pollAt) continue; // The scanning copy closed or reloaded.
    return scan;
  }
  return null;
}

// 按文件名 / 扩展名 / 文件夹名挑图标；挑不到就用默认的 file / folder。
// 顺序照 VS Code：完整文件名优先于扩展名（package.json 应该是 npm 图标，不是 json）。
function iconFor(name, isDir, expanded) {
  const lower = String(name).toLowerCase();
  if (isDir) {
    return FOR_DIR[lower] ?? (expanded ? FOLDER_OPEN : FOLDER);
  }
  const byName = FOR_NAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  return FOR_EXT[ext] ?? FILE;
}

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

class Browser extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(500, cx => this.refreshIfDue(cx));
    // 弹窗回传：files-mine.<op>:<json>。整段 JSON 走 JSON.parse，名字里带冒号空格都不怕。
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        const at = cmd.indexOf(":");
        const op = at > 0 ? cmd.slice(0, at).replace(/^files-mine\./, "") : cmd.replace(/^files-mine\./, "");
        let args = {};
        try { args = at > 0 ? JSON.parse(cmd.slice(at + 1)) : {}; } catch { /* 没参数 */ }
        if (await this.onMenu(op, args, cx) === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
  }

  refreshIfDue(cx) {
    const active = window()?.active !== false, context = this.context;
    const refocused = active && this.windowActive === false;
    this.windowActive = active;
    if (!context) return;
    if (refocused && (context.dirtyAt || !context.watch)) context.catchUp = true;
    if (!active || this.loading) return;
    const now = Date.now();
    if (context.catchUp || (context.dirtyAt && now >= context.watchAt) || now >= context.pollAt) this.refresh(cx);
  }

  watch(root, context, cx) {
    if (context.on || context.watch?.root === root) return;
    context.watch?.pending?.cancel();
    const watch = { root };
    context.watch = watch;
    cx.spawn(async cx => {
      try {
        while (this.context === context && context.watch === watch) {
          watch.pending = watchFolder(root);
          const paths = await watch.pending;
          if (paths.length && context.watch === watch && this.current(context)) {
            context.dirtyAt = Date.now() + 1;
            this.refreshIfDue(cx);
          }
        }
      } catch {
        if (context.watch === watch) context.watch = null;
      }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    const visiting = next !== this.context?.key;
    if (visiting) {
      if (this.context) {
        this.saved.set(this.context.key, { folders: this.folders, file: this.file });
        this.context.watch?.pending?.cancel();
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, dirtyAt: 0 }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    const context = this.context;
    const now = Date.now();
    if (!cwd) {
      context.catchUp = false;
      context.dirtyAt = 0;
      context.pollAt = now + 10000;
      return;
    }
    if (this.loading) return;
    if (context.catchUp && !context.dirtyAt) context.dirtyAt = now + 1;
    const request = {
      after: visiting ? now + 1 : context.dirtyAt || (context.lastStatus ?? -1) + 1,
      visiting,
      urgent: visiting || context.catchUp,
      allowInactive: visiting,
    };
    context.catchUp = false;
    context.pollAt = context.watchAt = now + 10000;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        this.watch(cwd, context, cx);
        const dirtyAtListing = context.dirtyAt;
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        if (!this.current(context)) return;
        const marks = {};
        let covered = dirtyAtListing;
        if (top?.code === 0) {
          const root = top.stdout.trim();
          const scan = await repoStatus(root, on, request, cx, () => this.context === context);
          if (!scan || !this.current(context)) return;
          const { status, started, pollAt, watchAt } = scan;
          context.lastStatus = started;
          context.pollAt = pollAt;
          context.watchAt = watchAt;
          covered = Math.min(dirtyAtListing, started);
          if (request.urgent && request.after > started) context.catchUp = true;
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${root}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        } else {
          context.watchAt = Date.now();
        }
        if (!this.current(context)) return;
        if (context.dirtyAt <= covered) context.dirtyAt = 0;
        this.marks = marks; this.error = null;
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // ---- 右键菜单 + 文件操作 ----------------------------------------------
  // 弹窗（abs-detail 的 menu 视图）点一项就 run("files-mine.<op>:<json>") 回到这里，
  // 和铁律弹窗同一条通道；路径带空格 / 冒号也没事，整段是 JSON。
  // 右键：空白处 / 文件夹 / 文件，三种菜单。
  //   空白处：新建文件、新建文件夹、三个「打开」
  //   文件夹：新建文件、新建文件夹、重命名、删除、复制
  //   文件：  重命名、删除、复制
  // 菜单项的 args 里带 path（文件夹上新建要建在那个文件夹里）。
  contextMenu(path, dir) {
    const full = path ? `${this.root}/${path}` : this.root;
    const base = (label, op, args) => [label, `files-mine.${op}`, args];
    const items = [
      ...(!path || dir ? [
        base("新建文件", "new.file", { dir: full }),
        base("新建文件夹", "new.dir", { dir: full }),
      ] : []),
      ...(!path ? [
        base("在 VS Code 中打开", "editor", { app: "vscode", path: full }),
        base("在 Zed 中打开", "editor", { app: "zed", path: full }),
        base("在文件窗口中打开", "editor", { app: "files", path: full }),
      ] : []),
      ...(path ? [
        base("重命名", "rename", { path: full, name: path.split("/").pop() }),
        base("删除", "delete", { path: full, name: path.split("/").pop(), dir }),
        base("复制路径", "copy", { text: full }),
        base("复制相对路径", "copy", { text: path }),
      ] : []),
    ];
    openOverlay({ mod: "abs-detail", kind: "popup", width: 210, props: { view: "menu", items } });
  }

  // 需要输入 / 确认的操作先开弹窗，确认后带着 value 再发第二条同名命令才真正执行。
  askForm(op, args) {
    // 高度不传：弹窗按内容撑，不写死。
    const dialog = (props, w) => openOverlay({ mod: "abs-detail", kind: "dialog", modal: true, width: w, props });
    if (op === "new.file" || op === "new.dir") {
      dialog({
        title: op === "new.dir" ? "新建文件夹" : "新建文件",
        input: { placeholder: "名字", value: "" },
        submitLabel: "创建",
        submit: { name: `files-mine.${op}`, args: { dir: args.dir } },
      }, 400);
      return true;
    }
    if (op === "rename") {
      dialog({
        title: "重命名",
        input: { placeholder: "新名字", value: args.name ?? "" },
        submitLabel: "重命名",
        submit: { name: "files-mine.rename", args: { path: args.path } },
      }, 400);
      return true;
    }
    if (op === "delete") {
      dialog({
        view: "confirm",
        title: "删除",
        message: `确定删除${args.dir ? "文件夹" : "文件"}「${args.name}」？这一步不能撤销。`,
        submitLabel: "删除",
        submit: { name: "files-mine.delete", args: { path: args.path, confirmed: true } },
      }, 400);
      return true;
    }
    return false;
  }

  // 弹窗回传：files-mine.<op>:<json>。返回 "refresh" 让监听方重扫。
  // 所有路径参数都过 inRoot()：必须在 root 之下、且不等于 root —— JSON 是回传链路
  // 拼出来的，出岔子时空串或 root 本身绝不能流到 rm/mv 手里。
  async onMenu(op, args, cx) {
    const on = this.on, root = this.root;
    const sh = (script, ...argv) => exec("sh", ["-c", script, "fm", ...argv], { on });
    const inRoot = (p) => typeof p === "string" && p.startsWith(root + "/") && p.length > root.length + 1;
    const bad = (what, r) => notify({ title: `${what}失败`, body: String(r?.stderr || r?.stdout || r || "").trim().split("\n")[0].slice(0, 90), level: "error", timeout: 3500 });
    const noName = () => notify({ title: "名字不合法", level: "error", timeout: 2500 });
    if (op === "copy") { if (typeof args.text !== "string") return null; cx.write_to_clipboard(args.text); notify({ title: "已复制", body: args.text.split("/").pop(), level: "info", timeout: 1200 }); return null; }
    if (op === "editor") { openInEditor(args.app, args.path, on); return null; }
    // 新建 / 重命名 / 删除：菜单点过来时没有 value，先开弹窗；弹窗回传才带 value。
    if (args.value == null && !args.confirmed && ["new.file", "new.dir", "rename", "delete"].includes(op)) {
      this.askForm(op, args);
      return null;
    }
    if (op === "new.file" || op === "new.dir") {
      const name = String(args.value ?? "").trim();
      if (!name || name.includes("/") || name === "." || name === "..") return noName();
      // 文件夹里建：那个目录得在 root 下；空白处建 dir === root。
      if (args.dir !== root && !inRoot(args.dir)) return noName();
      const target = `${args.dir}/${name}`;
      // 新建文件不能把已有的清空：先 test 不存在再创建（noclobber 同义，报错更清楚）。
      const script = op === "new.dir"
        ? 'mkdir -p -- "$1"'
        : '[ -e "$1" ] && { echo "已存在同名" >&2; exit 1; }; : > "$1"';
      const r = await sh(script, target);
      if (r?.code !== 0) { bad("新建", r); return null; }
      if (args.dir !== root) this.folders.add(args.dir.slice(root.length + 1));
      return "refresh";
    }
    if (op === "rename") {
      const name = String(args.value ?? "").trim();
      if (!name || name.includes("/") || name === "." || name === "..") return noName();
      if (!inRoot(args.path)) return noName();
      const to = `${args.path.slice(0, args.path.lastIndexOf("/"))}/${name}`;
      if (to === args.path) return null;
      // 目标已存在就不覆盖；报出来而不是静默不动
      const r = await sh('[ -e "$2" ] && { echo "已存在同名" >&2; exit 1; }; mv -n -- "$1" "$2"', args.path, to);
      if (r?.code !== 0) { bad("重命名", r); return null; }
      // 展开状态跟着改名走：a/b → a/c，a/b/x → a/c/x
      const from = args.path.slice(root.length + 1), toRel = to.slice(root.length + 1);
      this.folders = new Set([...this.folders].map((f) => (f === from || f.startsWith(from + "/") ? toRel + f.slice(from.length) : f)));
      return "refresh";
    }
    if (op === "delete") {
      if (!inRoot(args.path)) return noName();
      const r = await sh('rm -rf -- "$1"', args.path);
      if (r?.code !== 0) { bad("删除", r); return null; }
      // 展开状态清掉；正在看着这个文件（或这个文件夹里的东西）的弹窗也关掉。
      const rel = args.path.slice(root.length + 1);
      this.folders = new Set([...this.folders].filter((f) => !(f === rel || f.startsWith(rel + "/"))));
      // 正在看这个文件 / 这个文件夹里的东西的弹窗，关掉。
      for (const [w, id] of this.viewers ?? []) if (w === args.path || w.startsWith(args.path + "/")) { closeOverlay(id); this.viewers.delete(w); }
      return "refresh";
    }
    return null;
  }

  // 点文件不挤进这个面板：弹一个浮窗，本机远程都可编辑保存。
  // 点文件不挤进这个面板：弹一个浮窗，本机远程都可编辑保存。
  openViewer(path) {
    if (!this.root) return;
    const id = openOverlay({
      mod: "files-mine",
      kind: "dialog",
      modal: true,
      width: 0.82,
      height: 0.82,
      props: { part: "viewer", path, root: this.root, on: this.on },
    });
    // 记着开着的弹窗：删除文件时能把它关掉，不让窗指着一个不存在的文件。
    this.viewers ??= new Map();
    this.viewers.set(`${this.root}/${path}`, id);
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.openViewer(path))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.contextMenu(path, entry.dir); })
        // 文件夹的展开/折叠已经体现在图标上（folder-open / folder），前面不再放箭头。
        .child(image(`mods/files-mine/icons/${iconFor(entry.name, entry.dir, open)}`).w(15).h(15).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    this.lastCx = cx;
    if (key() !== this.context?.key) this.refresh(cx);
    else this.refreshIfDue(cx);
    const t = theme();
    const font = this.code ? settings() : null;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.contextMenu(null, true); })
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code
        ? Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}

// 浮窗里的文件内容：带语法高亮，本机远程都可编辑、Cmd/Ctrl-S 保存。
// 关窗时有未保存的改动先在窗内确认（确认期间编辑器让位成静态预览，
// retained 控件画在一切自绘元素之上，只能请它离开）。
class Viewer {
  init(_p, cx) {
    this.p = props() ?? {};
    this.code = null;
    this.error = null;
    this.dirty = false;
    this.confirming = false;
    this.load(cx);
  }

  load(cx) {
    const { path, root, on } = this.p;
    if (!path || !root) { this.error = "Missing file"; return; }
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (text === null) { this.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.saved = text;
        // 超过 400KB 的只给看前半截：截断的内容存回去会把后半截丢掉，所以强制只读。
        const truncated = text.length > 400000;
        this.readonly = truncated;
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: truncated,
          soft_wrap: true,
          value: truncated ? text.slice(0, 400000) + "\n… (file too long, readonly)" : text,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
        });
        // 第一次改动就置脏，不在每次按键里全量取文本比对。
        this.code.on("change", () => { if (!this.dirty) { this.dirty = true; cx.notify(); } });
      } catch {
        this.error = "Cannot preview this file (binary, too large, or unreadable)";
      } finally {
        cx.notify();
      }
    });
  }

  // 保存：expected 带原文，别处先改过就拒绝。closeAfter：确认框里的「保存」。
  save(cx, closeAfter = false) {
    if (!this.code || this.saving || this.readonly) return;
    const path = `${this.p.root}/${this.p.path}`;
    const on = this.p.on;
    const text = this.code.value();
    this.saving = true;
    cx.spawn(async cx => {
      try {
        if (on) {
          // 远程：先重读确认没被别人改过，再走 sh + heredoc 写回。
          const cur = await readTextFile(path, { on });
          if (cur !== this.saved) throw new Error("文件在远程已被别人改过，保存拒绝");
          await shellWrite(path, text, on);
        } else {
          await writeTextFile(path, text, this.saved);
        }
        this.saved = text;
        this.dirty = false;
        notify({ title: "已保存", body: this.p.path.split("/").pop(), level: "success", timeout: 2500 });
        if (closeAfter) { this.code?.release(); closeOverlay(this.p.overlay); return; }
      } catch (e) {
        notify({ title: "保存失败", body: String(e).slice(0, 100), level: "error", timeout: 4000 });
        this.confirming = false;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  close(cx) {
    if (this.dirty && !this.confirming) { this.confirming = true; cx.notify(); return; }
    this.code?.release();
    closeOverlay(this.p.overlay);
  }

  // 确认盒：不保存 = 直接丢弃退出；底下垫静态预览，文档不至于凭空消失。
  confirmView(t) {
    const cancel = (_e, cx) => { this.confirming = false; cx.notify(); };
    return div().absolute().inset_0().flex().items_center().justify_center()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); cancel(_e, cx); })
      .child(v_flex().w(320).p(18).gap(10).rounded(12).bg(t.background).border_1().border_color(t.border)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("未保存的修改"))
        .child(div().text_size(12).text_color(t.muted).child(`${this.p.path?.split("/").pop() ?? "This file"} has unsaved changes.`))
        .child(h_flex().justify_end().gap(8).flex_none()
          .child(h_flex().id("fv-quit-no").h(30).px(12).items_center().rounded(8).border_1().border_color(t.border)
            .text_size(12).text_color(t.foreground).cursor_pointer()
            .hover(s => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click(() => { this.code?.release(); closeOverlay(this.p.overlay); }).child("不保存"))
          .child(h_flex().id("fv-quit-yes").h(30).px(12).items_center().rounded(8).bg(t.solid)
            .text_size(12).text_color(t.solid_foreground).cursor_pointer()
            .hover(s => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { this.confirming = false; this.save(cx, true); }).child("保存"))));
  }

  // 确认期间垫底的静态预览：纯 div，能被确认盒盖住。
  // 确认期间垫底的静态预览：只取前 2 万字符，长文件不把几千行都铺出来。
  previewView(t) {
    const text = this.code ? this.code.value() : "";
    const cut = text.length > 20000;
    const lines = (cut ? text.slice(0, 20000) : text).split("\n");
    if (cut && lines.length > 1) lines.pop();
    return div().flex_1().min_h(0).overflow_y_scrollbar().px(18).py(10).opacity(0.45)
      .child(v_flex().gap(1).w_full().children([
        ...lines.map(line => div().w_full().text_size(12).text_color(t.muted).child(line || " ")),
        ...(cut ? [div().w_full().text_size(12).text_color(t.dim).child("…")] : []),
      ]));
  }

  render(cx) {
    const t = theme();
    const name = this.p.path?.split("/").pop() ?? "File";
    const font = this.code ? settings() : null;
    return v_flex().size_full().min_h(0).relative().bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if ((e.modifiers.platform || e.modifiers.control) && e.key === "s") {
          if (this.confirming) { this.confirming = false; this.save(cx, true); }
          else this.save(cx);
          cx.stop_propagation();
          return;
        }
        if (e.key === "escape") {
          if (this.confirming) { this.confirming = false; cx.notify(); }
          else this.close(cx);
          cx.stop_propagation();
        }
      })
      .child(
        h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().text_size(13).font_semibold().child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.p.path ?? ""))
          .when(this.dirty, el => el.child(div().size(7).rounded_full().bg(t.ansi1)))
          .child(h_flex().id("viewer-close").size(24).items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
            .hover(el => el.bg(t.raised).text_color(t.foreground))
            .on_click((_e, cx) => this.close(cx)).child("×")),
      )
      .child(
        this.code && !this.confirming
          ? Editor.new(this.code).font_family(font.font_family).text_size(font.font_size).flex_1().min_h(0)
          : this.confirming
            ? this.previewView(t)
            : div().flex_1().p(12).text_color(t.dim).child(this.error || "Loading file…"),
      )
      .when(Boolean(this.confirming), el => el.child(this.confirmView(t)));
  }
}

// 一个 mod 两副面孔：布局里是文件树（不填 part），浮窗里是文件内容（part: "viewer"）。
export default class FilesMine extends View {
  init(_p, cx) {
    const p = props();
    if (p?.part === "viewer") {
      this.viewer = new Viewer();
      this.viewer.init(p, cx);
    } else {
      this.browser = new Browser();
      this.browser.init(p, cx);
    }
  }

  render(cx) {
    return this.viewer ? this.viewer.render(cx) : this.browser.render(cx);
  }
}
