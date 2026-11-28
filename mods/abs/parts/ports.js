// 端口转发窗口：右上角按钮打开。两类转发分开管理：
//
//   配置类 —— 读 ~/.ssh/config 的 LocalForward。改端口 / 删行直接写 config
//   （先备份，改完跑 ssh -G 校验，失败还原），只影响下一次连接；
//   那台机器此刻若被 herdr 连着，旧端口要等这条连接断开才释放。
//
//   临时类 —— 记在 ~/.config/herdr-app/abs-ports.json（一个字都不写 config）。
//   用 `hc run --bg` 起一条 ssh -N -L 隧道，进程归 herdr 核心托管；关闭
//   herdr 靠不住（核心保活终端、mod 没有退出钩子），所以每次打开时清理：
//   杀掉带 abs.pf 标签的终端，清空临时记录。下次打开就是干净的列表。
//
// 记录文件只表示"想要什么"，实际状态一律现查：lsof 看端口、terminals() 看
// 进程。两者不一致以现查为准并修正记录。
//
// 列表以服务器为准：同一台机器（herdr 的 machine）下的所有工作区看到同一份
// 列表，切工作区不变；本机项目没有服务器，列表为空。

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, theme, exec, hc, home, appHome, readTextFile, writeTextFile, notify, terminals, machines } from "herdr";
import { icon, activeSpace, btnCancel, btnPrimary, inputShell, field, footer } from "./lib.js";

const RECORD = () => `${appHome()}/abs-ports.json`;
const SSH_CONFIG = () => `${home()}/.ssh/config`;

// ---- 小工具 --------------------------------------------------------------

function sleep(ms) {
  return exec("sleep", [(ms / 1000).toFixed(2)]).catch(() => null);
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function rand() {
  return Math.random().toString(36).slice(2, 8);
}

// ---- 解析 ~/.ssh/config ---------------------------------------------------

// 返回 [ { host, localPort, remoteAddr, remotePort, kind, global, line, raw } ]
// kind: "tcp" 普通转发 / "socket" unix socket 转发（不支持改）
function parseSshConfig(text) {
  const out = [];
  let host = null;
  let global = false;
  const lines = (text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^Include\b/i.test(line)) continue; // 如 Include ~/.orbstack/ssh/config，跳过
    const hm = line.match(/^Host\s+(.+)$/i);
    if (hm) {
      host = hm[1].trim().split(/\s+/)[0];
      global = host === "*";
      continue;
    }
    if (!/^LocalForward\b/i.test(line) || !host) continue;
    const parts = line.split(/\s+/);
    const local = parts[1];
    const remote = parts[2];
    if (!local || !remote) continue;
    const localPort = local.includes(":") ? local.slice(local.lastIndexOf(":") + 1) : local;
    if (remote.includes(":") && !remote.startsWith("/")) {
      const idx = remote.lastIndexOf(":");
      out.push({ host, localPort, remoteAddr: remote.slice(0, idx), remotePort: remote.slice(idx + 1), kind: "tcp", global, line: i, raw });
    } else if (remote.startsWith("/")) {
      out.push({ host, localPort, remoteAddr: null, remotePort: null, kind: "socket", global, line: i, raw });
    }
  }
  return out;
}

// config 里出现过的 Host（去重，保序）。
function configHosts(text) {
  const hosts = [];
  const seen = new Set();
  for (const line of (text || "").split("\n")) {
    const hm = line.trim().match(/^Host\s+(.+)$/i);
    if (!hm) continue;
    const h = hm[1].trim().split(/\s+/)[0];
    if (h !== "*" && !seen.has(h)) { seen.add(h); hosts.push(h); }
  }
  return hosts;
}

// ssh 别名 → 服务器名（herdr 的机器名）。两边常只差大小写（MACOS / macos），
// 记录按服务器存，切工作区才不会看成两台。
function machineFor(host) {
  const name = machines().find((m) => m.name && m.name.toLowerCase() === String(host ?? "").toLowerCase())?.name;
  return name ?? host;
}

// 记录里的哪台服务器（老记录只有 host）。
const serverOf = (t) => t.machine ?? t.host ?? "";

// 从真在跑的终端里反推转发（回退）：记录丢了、或从没写过记录，只要 ssh -N -L
// 进程还在，就还能把它找回来，不靠记录文件当唯一真相。
// 返回 [{ id, host, localPort, remoteAddr, remotePort, terminal }]
function discoverTunnels(terms) {
  const out = [];
  for (const t of terms) {
    const argv = t.argv ?? [];
    if (!argv.some((a) => /(^|\/)ssh$/.test(a))) continue;
    if (!argv.includes("-N")) continue;
    const host = argv[argv.length - 1];
    if (!host || host.startsWith("-")) continue;
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] !== "-L") continue;
      const spec = String(argv[i + 1] ?? "");
      const parts = spec.split(":");
      // 127.0.0.1:5173:127.0.0.1:80 或 5173:127.0.0.1:80
      const [localPort, remoteAddr, remotePort] = parts.length === 4 ? parts.slice(1) : parts.length === 3 ? parts : [];
      if (!/^\d+$/.test(localPort ?? "") || !/^\d+$/.test(remotePort ?? "") || !remoteAddr) continue;
      out.push({
        id: `found-${t.address}-${localPort}`,
        host,
        localPort,
        remoteAddr,
        remotePort,
        terminal: t.address,
      });
    }
  }
  return out;
}

// ---- 端口占用探测 ---------------------------------------------------------

// 解析 lsof -nP -iTCP -sTCP:LISTEN 的输出 → Map<端口, { command, pid }>。
// NAME 列形如 127.0.0.1:5173、*:8000、[::1]:5173。
function parseListen(text) {
  const map = new Map();
  const lines = String(text ?? "").trim().split("\n");
  for (const raw of lines.slice(1)) {
    // lsof 开了 -sTCP:LISTEN 会在行尾多一段 "(LISTEN)"，先去掉再分列。
    const cols = raw.replace(/\s*\(LISTEN\)\s*$/, "").trim().split(/\s+/);
    if (cols.length < 3) continue;
    const name = cols[cols.length - 1];
    if (!/:\d+$/.test(name)) continue;
    const port = name.slice(name.lastIndexOf(":") + 1);
    if (map.has(port)) continue;
    map.set(port, { command: cols[0], pid: cols[1] });
  }
  return map;
}

// 一次读出本机所有监听端口。refresh 里端口可能有十几个，一个端口跑一次 lsof
// 就是十几次进程启动，切服务器要等好几秒。
async function listenSnapshot() {
  const r = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]).catch(() => ({ code: 1, stdout: "" }));
  return parseListen(r.stdout);
}

// 有人监听就返回 { command, pid }，否则 null。单个端口现查（waitFree 用）。
async function portOwner(port) {
  const r = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).catch(() => ({ code: 1, stdout: "" }));
  for (const owner of parseListen(r.stdout).values()) return owner;
  return null;
}

// 占用者描述：非 ssh 直接 "命令 (pid n)"；ssh 尽量找出它连的是哪台机器。
async function describeOwner(owner) {
  if (!owner) return null;
  if (owner.command !== "ssh") return `${owner.command} (pid ${owner.pid})`;
  const r = await exec("ps", ["-o", "command=", "-p", owner.pid]).catch(() => ({ stdout: "" }));
  const cmd = (r.stdout || "").trim();
  let host = null;
  const mT = cmd.match(/-T\s+(\S+)/); // herdr 的连接：ssh ... -T <host> sh -c ...
  if (mT) host = mT[1];
  else {
    const tokens = cmd.split(/\s+/);
    const last = tokens[tokens.length - 1];
    if (last && !last.startsWith("-") && last !== "sh" && last !== "ssh" && last !== "true") host = last;
  }
  return host ? `ssh ${host} (pid ${owner.pid})` : `ssh (pid ${owner.pid})`;
}

// ---- 临时记录 -------------------------------------------------------------

async function readRecord() {
  const text = await readTextFile(RECORD()).catch(() => null);
  try { return (JSON.parse(text)?.tunnels) ?? []; } catch { return []; }
}

async function writeRecord(tunnels) {
  const path = RECORD();
  const prev = await readTextFile(path).catch(() => null);
  await writeTextFile(path, JSON.stringify({ tunnels }, null, 2), prev).catch(() => null);
}

// ---- 隧道启动 / 停止 ------------------------------------------------------

// 起一条 ssh -N -L，返回终端 address；失败返回 null。
// 终端带上 abs.pf=<id> 标签：重启后地址会重新编号、可能被别的终端复用，
// 只有标签能认出「这条进程是我们起的隧道」。
async function startTunnel(host, localPort, remoteAddr, remotePort, id) {
  const name = `pf-${localPort}-${rand()}`;
  const r = await hc(["run", "--json", "--bg", "--no-parent", "--name", name, "--label", `abs.pf=${id}`, "--",
    "ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    "-L", `127.0.0.1:${localPort}:${remoteAddr}:${remotePort}`, host]).catch(() => ({ code: 1, stdout: "" }));
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout).address; } catch { return null; }
}

// 记录里的 address 是不是我们那条隧道。重启电脑后 herdr 会把地址从头编号，
// 旧的 t8 很可能已经属于别人的 pane，光比地址会把别人的终端当成自己的。
function isOurTerminal(term, id) {
  if (!term) return false;
  return (term.labels ?? {})["abs.pf"] === id;
}

// 升级前起的隧道没有 abs.pf 标签。地址还在、argv 又确实是 ssh -N -L 且本地端口
// 对得上的，就认成自己那条（补标签），别把还在跑的隧道从面板里抹掉。
function looksLikeTunnel(term, localPort) {
  if (!term) return false;
  const argv = term.argv ?? [];
  if (!argv.some((a) => /(^|\/)ssh$/.test(a))) return false;
  if (!argv.includes("-N")) return false;
  return argv.some((a) => a.includes(`:${localPort}:`));
}

// 只在「地址还在」且「确实是我们起的隧道」时才 kill。
// 否则 core 会报 no terminal "t8"（弹通知），复用的地址还会误杀别人的 pane。
function stopTunnel(terminal, id) {
  if (!terminal) return false;
  const term = terminals().find((t) => t.address === terminal);
  if (!isOurTerminal(term, id)) return false;
  run("terminal.kill", { terminal });
  return true;
}

// 读隧道终端的输出（拿 ssh 的报错原文）。
async function readTunnel(terminal) {
  if (!terminal) return "";
  const r = await hc(["read", terminal]).catch(() => ({ stdout: "" }));
  return (r.stdout || "").trim();
}

async function waitFree(port) {
  for (let i = 0; i < 10; i++) {
    if (!(await portOwner(port))) return true;
    await sleep(200);
  }
  return false;
}

// ---- config 的修改 --------------------------------------------------------

async function backupConfig() {
  const path = SSH_CONFIG();
  const text = await readTextFile(path).catch(() => null);
  if (text == null) return null;
  const bak = `${path}.bak.${stamp()}`;
  await writeTextFile(bak, text, null).catch(() => null);
  return { bak, text };
}

function setConfigPort(line, newPort) {
  return line.replace(/^(\s*LocalForward\s+)(\S+)(\s+)/i, (_m, p1, port, p3) => {
    const token = port.includes(":") ? `${port.slice(0, port.lastIndexOf(":") + 1)}${newPort}` : String(newPort);
    return p1 + token + p3;
  });
}

function dropConfigLine(text, lineNo) {
  const lines = text.split("\n");
  lines.splice(lineNo, 1);
  return lines.join("\n");
}

async function verifyConfig(host) {
  const r = await exec("ssh", ["-G", host]).catch(() => ({ code: 1 }));
  return r.code === 0;
}

// ---- 视图 -----------------------------------------------------------------

export default class Ports extends View {
  init(_props, cx) {
    this.items = [];   // 渲染用（config + tunnel 合并，已按当前机器过滤）
    this.hosts = [];   // config 里所有 Host
    this.form = null;  // 新增 / 编辑表单状态
    this.note = null;
    this.loading = true;
    this.busy = false;
    this.refreshing = false;
    this.refreshAgain = false;
    // 表单输入框预创建一次，openForm 时 set_value 复用，避免每次点击都 new（慢且漏原生句柄）。
    this.inputLocal = InputState.new({ placeholder: "本机端口" });
    this.inputRemoteAddr = InputState.new({ placeholder: "127.0.0.1" });
    this.inputRemotePort = InputState.new({ placeholder: "远程端口" });
    // 聚焦态：输入框边框变 accent 用。
    const track = (state, key) => {
      state.on("focus", (_e, cx) => { this[key] = true; cx.notify(); });
      state.on("blur", (_e, cx) => { this[key] = false; cx.notify(); });
    };
    track(this.inputLocal, "typingLocal"); track(this.inputRemoteAddr, "typingAddr"); track(this.inputRemotePort, "typingPort");
    cx.spawn(async (cx) => {
      await this.cleanup();
      await this.refresh(cx);
      cx.notify();
    });
  }

  // 端口列表以服务器为准：同一台机器（machine）下的所有工作区看到同一份列表，
  // 切工作区不变。本机项目没有服务器，返回 null（列表空）。
  // 一台机器在 ssh config 里可能对应不止一个别名，全部算这台服务器。
  currentServer() {
    const machine = activeSpace()?.machine ?? null;
    if (!machine) return null;
    const aliases = this.hosts.filter((h) => h.toLowerCase() === machine.toLowerCase());
    return { machine, aliases: aliases.length ? aliases : [machine] };
  }

  // 新建 / 编辑时写哪个 ssh 别名：config 里能对上机器名的那个，否则用机器名。
  currentHost() {
    return this.currentServer()?.aliases[0] ?? null;
  }

  // 打开时核对记录与现查结果（herdr-core 重启后隧道没了，只剩死记录）。
  // 判活必须比标签：重启后地址重新编号，只看地址还在就把死记录当成活的。
  // 旧版本起的隧道没有标签，argv 对得上就补标签认领 —— 升级不该让它凭空消失。
  async cleanup() {
    const tunnels = await readRecord();
    if (!tunnels.length) return;
    const alive = new Map(terminals().map((t) => [t.address, t]));
    const kept = [];
    let changed = false;
    for (const t of tunnels) {
      const term = alive.get(t.terminal);
      if (isOurTerminal(term, t.id)) { kept.push(t); continue; }
      if (looksLikeTunnel(term, t.localPort)) {
        const r = await hc(["label", term.address, `abs.pf=${t.id}`]).catch(() => ({ code: 1 }));
        if (r.code === 0) { kept.push(t); continue; }
      }
      changed = true;
    }
    if (changed) await writeRecord(kept);
  }

  refresh(cx) {
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    this.refreshAgain = false;
    cx.spawn(async (cx) => {
      try {
        // 三件事并行：读 ssh config、读记录、一次读完全部监听端口。
        const [configText, allTunnels, listen] = await Promise.all([
          readTextFile(SSH_CONFIG()).catch(() => null),
          readRecord(),
          listenSnapshot(),
        ]);
        const allConfigs = configText ? parseSshConfig(configText) : [];
        this.hosts = configText ? configHosts(configText) : [];
        // 按服务器取列表：同一台机器下的所有工作区内容相同，本机项目为空。
        const server = this.currentServer();
        const aliases = server ? server.aliases.map((a) => a.toLowerCase()) : [];
        const sameServer = (name) => Boolean(server) && String(name ?? "").toLowerCase() === server.machine.toLowerCase();
        const configs = allConfigs.filter((c) => aliases.includes(c.host.toLowerCase()));
        const terms = terminals();
        // 回退：记录里没有但进程还在的隧道，按实际 ssh -N -L 认领回来（并补标签、
        // 写回记录），否则记录一丢、面板里就永远看不见这条还在跑的转发。
        const known = new Set(allTunnels.map((t) => t.terminal));
        let added = false;
        for (const f of server ? discoverTunnels(terms) : []) {
          if (known.has(f.terminal)) continue;
          if (!aliases.includes(String(f.host).toLowerCase())) continue;
          allTunnels.push({ ...f, machine: server.machine, stopped: false, note: null });
          known.add(f.terminal);
          added = true;
          await hc(["label", f.terminal, `abs.pf=${f.id}`]).catch(() => null);
        }
        if (added) await writeRecord(allTunnels);
        const tunnels = allTunnels.filter((t) => sameServer(serverOf(t)));
        const byAddr = new Map(terms.map((t) => [t.address, t]));

        // 先探测所有相关端口，再组装。
        const ports = new Set([...configs.map((c) => c.localPort), ...tunnels.map((t) => t.localPort)]);
        const owners = new Map();
        const descCache = new Map(); // pid -> 描述，同 pid 只 ps 一次
        for (const p of ports) {
          const o = listen.get(String(p));
          if (!o) continue;
          if (!descCache.has(o.pid)) descCache.set(o.pid, await describeOwner(o));
          owners.set(p, { ...o, desc: descCache.get(o.pid) });
        }

        const items = [];
        for (const c of configs) {
          const owner = owners.get(c.localPort);
          items.push({
            ...c,
            source: "config",
            id: `cfg-${c.host}-${c.localPort}-${c.remoteAddr}-${c.remotePort}`,
            running: Boolean(owner),
            ownerDesc: owner?.desc ?? null,
            editable: !c.global && c.kind === "tcp",
          });
        }
        for (const t of tunnels) {
          const term = byAddr.get(t.terminal);
          const ours = isOurTerminal(term, t.id);
          const owner = owners.get(t.localPort);
          const termLive = ours && term.state === "live";
          const running = termLive && Boolean(owner);
          const stopped = Boolean(t.stopped);
          const dead = !ours; // 终端消失（herdr-core 重启，或地址被别的终端复用）
          const failed = termLive && !owner; // 进程在但端口没监听
          items.push({
            ...t,
            source: "tunnel",
            id: t.id,
            running,
            stopped,
            dead,
            failed,
            failedNote: failed ? "隧道进程在但端口未监听" : (t.note ?? null),
            ownerDesc: owner?.desc ?? null,
            editable: true,
          });
        }

        this.items = items;
      } catch (e) {
        this.note = `读取失败：${String(e?.message ?? e)}`;
      } finally {
        this.refreshing = false;
        this.loading = false;
      }
      cx.notify();
      if (this.refreshAgain) this.refresh(cx);
    });
  }

  openForm(mode, item) {
    const host = mode === "add" ? this.currentHost() : item.host;
    this.inputLocal.set_value(mode === "add" ? "" : String(item.localPort));
    this.inputRemoteAddr.set_value(mode === "add" ? "127.0.0.1" : (item.remoteAddr ?? "127.0.0.1"));
    this.inputRemotePort.set_value(mode === "add" ? "" : String(item.remotePort ?? ""));
    this.form = {
      mode,             // "add" | "edit-tunnel" | "edit-config"
      item: item ?? null,
      host,
      hostOpen: false,
      err: null,
    };
  }

  closeForm() {
    this.form = null;
  }

  // 表单提交。edit-config 只改本机端口；其余三个字段都要。
  submit(cx) {
    const f = this.form;
    if (!f || this.busy) return;
    const local = this.inputLocal.value().trim();
    const remoteAddr = this.inputRemoteAddr.value().trim() || "127.0.0.1";
    const remotePort = this.inputRemotePort.value().trim();
    const host = f.host;
    const isConfig = f.mode === "edit-config";
    if (!/^\d+$/.test(local)) { f.err = "本机端口必须是数字"; cx.notify(); return; }
    if (!isConfig && !/^\d+$/.test(remotePort)) { f.err = "远程端口必须是数字"; cx.notify(); return; }
    const lp = Number(local);
    const rp = Number(remotePort);
    if (lp < 1024 || lp > 65535) { f.err = "本机端口 1024–65535"; cx.notify(); return; }
    if (!isConfig && (rp < 1 || rp > 65535)) { f.err = "远程端口 1–65535"; cx.notify(); return; }
    this.busy = true;
    f.err = null;
    cx.spawn(async (cx) => {
      try {
        if (f.mode === "add") await this.doAdd(host, lp, remoteAddr, rp);
        else if (f.mode === "edit-tunnel") await this.doEditTunnel(f.item, host, lp, remoteAddr, rp);
        else await this.doEditConfig(f.item, lp);
        this.closeForm();
        this.busy = false;
        await this.refresh(cx);
      } catch (e) {
        if (this.form) this.form.err = String(e?.message ?? e);
        this.busy = false;
      }
      cx.notify();
    });
  }

  // 起一条临时隧道并落记录；端口占用 / 启动失败都抛错。
  // 自检：等端口监听；若 ssh 进程先退出（撞端口、host key、不可达等），立刻读原文报错，不等满 12 秒。
  async launchAndRecord(host, lp, remoteAddr, rp, id) {
    if (await portOwner(lp)) throw new Error(`端口 ${lp} 已被占用`);
    const terminal = await startTunnel(host, lp, remoteAddr, rp, id);
    if (!terminal) throw new Error("ssh 启动失败");
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (await portOwner(lp)) return terminal;
      const term = terminals().find((t) => t.address === terminal);
      if (term && term.state !== "live") {
        const out = await readTunnel(terminal);
        throw new Error(out ? `启动失败：${out.split("\n")[0]}` : "ssh 进程退出");
      }
      await sleep(300);
    }
    const out = await readTunnel(terminal);
    stopTunnel(terminal, id);
    throw new Error(out ? `启动失败：${out.split("\n")[0]}` : `端口 ${lp} 未监听`);
  }

  async doAdd(host, lp, remoteAddr, rp) {
    const id = `pf-${rand()}`;
    const terminal = await this.launchAndRecord(host, lp, remoteAddr, rp, id);
    const tunnels = await readRecord();
    tunnels.push({ id, host, machine: this.currentServer()?.machine ?? machineFor(host), localPort: lp, remoteAddr, remotePort: rp, terminal, stopped: false, note: null });
    await writeRecord(tunnels);
  }

  async doEditTunnel(item, host, lp, remoteAddr, rp) {
    const same = host === item.host && lp === Number(item.localPort) && remoteAddr === (item.remoteAddr ?? "127.0.0.1") && rp === Number(item.remotePort);
    if (same) return;
    const old = { terminal: item.terminal, running: item.running, host: item.host, localPort: item.localPort, remoteAddr: item.remoteAddr, remotePort: item.remotePort };
    // 旧隧道先停（改端口/主机要重起；本机端口没变时新隧道会因端口占用失败，所以一律先停）。
    stopTunnel(item.terminal, item.id);
    if (!(await waitFree(lp))) throw new Error(`端口 ${lp} 仍被占用`);
    let terminal = null;
    try {
      terminal = await this.launchAndRecord(host, lp, remoteAddr, rp, item.id);
    } catch (e) {
      const ok = await this.rollbackTunnel(item.id, old);
      throw new Error(ok ? `${e.message ?? e}，已回滚` : `${e.message ?? e}，且回滚失败，请手动检查`);
    }
    const tunnels = await readRecord();
    const x = tunnels.find((t) => t.id === item.id);
    if (x) { x.host = host; x.machine = item.machine ?? this.currentServer()?.machine ?? machineFor(host); x.localPort = lp; x.remoteAddr = remoteAddr; x.remotePort = rp; x.terminal = terminal; x.stopped = false; x.note = null; }
    await writeRecord(tunnels);
  }

  async rollbackTunnel(id, old) {
    const terminal = await startTunnel(old.host, Number(old.localPort), old.remoteAddr, Number(old.remotePort), id);
    if (!terminal) return false;
    const tunnels = await readRecord();
    const x = tunnels.find((t) => t.id === id);
    if (x) x.terminal = terminal;
    await writeRecord(tunnels);
    return true;
  }

  async doEditConfig(item, lp) {
    if (lp === Number(item.localPort)) return;
    if (await portOwner(lp)) throw new Error(`端口 ${lp} 已被占用`);
    const bk = await backupConfig();
    if (!bk) throw new Error("读不到 ~/.ssh/config");
    // 重新解析定位行：外部可能改过 config，缓存的行号会漂移，按内容重新找。
    const lineNo = parseSshConfig(bk.text).find((c) => c.host === item.host && c.localPort === item.localPort && c.remoteAddr === item.remoteAddr && c.remotePort === item.remotePort)?.line;
    if (lineNo == null) throw new Error("config 里找不到这一行（可能被外部改过）");
    const lines = bk.text.split("\n");
    lines[lineNo] = setConfigPort(lines[lineNo], lp);
    const full = lines.join("\n");
    await writeTextFile(SSH_CONFIG(), full, bk.text).catch(() => { throw new Error("写入 config 失败（文件被别处改过）"); });
    if (!(await verifyConfig(item.host))) {
      await writeTextFile(SSH_CONFIG(), bk.text, full).catch(() => null);
      throw new Error("写入后 ssh -G 校验失败，已还原");
    }
    notify({ title: `已改 ${item.host} 的端口 ${item.localPort} → ${lp}`, body: "下次连接该机器生效", level: "success" });
  }

  async doRemoveConfig(item) {
    const bk = await backupConfig();
    if (!bk) throw new Error("读不到 ~/.ssh/config");
    const lineNo = parseSshConfig(bk.text).find((c) => c.host === item.host && c.localPort === item.localPort && c.remoteAddr === item.remoteAddr && c.remotePort === item.remotePort)?.line;
    if (lineNo == null) throw new Error("config 里找不到这一行（可能被外部改过）");
    const full = dropConfigLine(bk.text, lineNo);
    await writeTextFile(SSH_CONFIG(), full, bk.text).catch(() => { throw new Error("写入 config 失败（文件被别处改过）"); });
    if (!(await verifyConfig(item.host))) {
      await writeTextFile(SSH_CONFIG(), bk.text, full).catch(() => null);
      throw new Error("删除后 ssh -G 校验失败，已还原");
    }
    notify({ title: `已删除 ${item.host} 的端口 ${item.localPort}`, body: "备份在 ~/.ssh/config.bak.*", level: "success" });
  }

  // 按钮动作：用事件回调的 cx（live）包进 spawn，出错写进 note。
  act(cx, fn) {
    if (this.busy || !cx) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await fn();
        this.busy = false;
        await this.refresh(cx);
      } catch (e) {
        this.note = String(e?.message ?? e);
        this.busy = false;
      }
      cx.notify();
    });
  }

  startItem(it, cx) {
    this.act(cx, async () => {
      // 旧进程（无论运行中还是残留）先停掉，等端口释放，避免重复起同端口。
      if (it.source === "tunnel") {
        stopTunnel(it.terminal, it.id);
        await waitFree(it.localPort);
      }
      const id = it.source === "config" ? `pf-${rand()}` : it.id;
      const terminal = await this.launchAndRecord(it.host, Number(it.localPort), it.remoteAddr, Number(it.remotePort), id);
      const tunnels = await readRecord();
      if (it.source === "config") {
        tunnels.push({ id, host: it.host, machine: this.currentServer()?.machine ?? machineFor(it.host), localPort: it.localPort, remoteAddr: it.remoteAddr, remotePort: it.remotePort, terminal, stopped: false, note: null });
      } else {
        const x = tunnels.find((t) => t.id === it.id);
        if (x) { x.terminal = terminal; x.machine = this.currentServer()?.machine ?? machineFor(x.host); x.stopped = false; x.note = null; }
      }
      await writeRecord(tunnels);
    });
  }

  stopItem(it, cx) {
    this.act(cx, async () => {
      stopTunnel(it.terminal, it.id);
      const tunnels = await readRecord();
      const x = tunnels.find((t) => t.id === it.id);
      if (x) { x.stopped = true; x.note = null; }
      await writeRecord(tunnels);
    });
  }

  removeItem(it, cx) {
    this.act(cx, async () => {
      if (it.source === "config") await this.doRemoveConfig(it);
      else {
        stopTunnel(it.terminal, it.id);
        const tunnels = (await readRecord()).filter((t) => t.id !== it.id);
        await writeRecord(tunnels);
      }
    });
  }

  // ---- 渲染 ---------------------------------------------------------------

  dot(it, t) {
    if (it.failed) return t.ansi1;
    if (it.running) return t.ansi2;
    return t.dim;
  }

  stateLabel(it) {
    if (it.source === "config") return it.running ? "生效中" : "未生效";
    if (it.dead) return "已失效";
    if (it.failed) return "异常";
    if (it.stopped) return "已停止";
    return it.running ? "运行中" : "已停止";
  }

  itemRow(it, t) {
    const canStart = !it.running;
    const canStop = it.source === "tunnel" && it.running;
    return v_flex()
      .id(`pf-${it.id}`)
      .w_full()
      .px(10)
      .py(8)
      .gap(5)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .child(
        h_flex().gap(8).items_center()
          .child(div().w(7).h(7).rounded_full().bg(this.dot(it, t)).flex_none())
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground)
            .child(`${it.localPort} → ${it.remoteAddr ?? "?"}:${it.remotePort ?? "?"}`))
          .child(div().flex_none().px(5).rounded(4).bg(t.hover).text_size(11).text_color(t.muted).child(it.host))
          .child(div().flex_none().text_size(11).text_color(it.failed ? t.ansi1 : t.dim).child(this.stateLabel(it))),
      )
      .child(
        h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
            .child(it.ownerDesc
              ? `占用人：${it.ownerDesc}`
              : it.source === "config"
                ? "来自 ssh 配置"
                : it.dead ? "上次会话残留，已失效" : it.failedNote || "临时转发"))
          .child(this.actions(it, t, canStart, canStop)),
      );
  }

  actions(it, t, canStart, canStop) {
    const btns = [];
    if (canStart) btns.push(this.btn(t, "启动", (cx) => this.startItem(it, cx)));
    if (canStop) btns.push(this.btn(t, "停止", (cx) => this.stopItem(it, cx)));
    if (it.editable) btns.push(this.btn(t, "编辑", (cx) => { this.openForm(it.source === "config" ? "edit-config" : "edit-tunnel", it); cx.notify(); }));
    btns.push(this.btn(t, "删除", (cx) => this.removeItem(it, cx), true));
    return h_flex().gap(4).children(btns);
  }

  btn(t, label, onClick, danger = false) {
    return div()
      .px(7)
      .py(3)
      .rounded(6)
      .text_size(11)
      .text_color(danger ? t.ansi1 : t.muted)
      .cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .hover((s) => s.bg(t.hover).text_color(danger ? t.ansi1 : t.foreground))
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  formView(t) {
    const f = this.form;
    if (!f) return null;
    const lockHost = f.mode === "edit-config";
    const hostsList = this.hosts.length
      ? this.hosts.map((h) =>
          h_flex().h(26).px(9).rounded(6).text_size(12).text_color(t.foreground).cursor_pointer()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .hover((s) => s.bg(t.hover))
            .when(h === f.host, (e) => e.bg(t.selected))
            .on_click((_e, cx) => { f.host = h; f.hostOpen = false; cx.notify(); })
            .child(h))
      : [div().px(9).py(5).text_size(12).text_color(t.dim).child("ssh config 里没有 Host")];
    const hostShell = inputShell(t, { onClick: lockHost ? null : (_e, cx) => { f.hostOpen = !f.hostOpen; cx.notify(); } },
      div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(f.host ?? "—"),
      ...(lockHost ? [] : [svg(icon("chevron-down")).size(12).flex_none().text_color(t.dim)]));
    // 聚焦态跟 InputState 的 focus/blur 事件走（init 里已挂到 this.typing*）。
    const input = (state, typing) => inputShell(t, { typing }, Input.new(state).h_full().flex_1().min_w(0).text_size(12).text_color(t.foreground));
    return v_flex().gap(12).w_full()
      .child(field(t, "主机（ssh 别名）",
        v_flex().gap(4).child(hostShell)
          .when(!lockHost && f.hostOpen, (e) => e.child(
            v_flex().p(3).rounded(7).border_1().border_color(t.border).max_h(150).overflow_y_scrollbar().children(hostsList)))))
      .child(field(t, "本机端口（127.0.0.1）", input(this.inputLocal, this.typingLocal)))
      .when(!lockHost, (e) => e
        .child(field(t, "远程地址", input(this.inputRemoteAddr, this.typingAddr)))
        .child(field(t, "远程端口", input(this.inputRemotePort, this.typingPort))))
      .when(lockHost, (e) => e.child(div().text_size(11).text_color(t.dim)
        .child(`远程目标：${f.item.remoteAddr ?? "?"}:${f.item.remotePort ?? "?"}（只改本机端口）`)))
      .when(f.err, (e) => e.child(div().px(9).py(6).rounded(7).bg(t.raised).border_1().border_color(t.ansi1).text_size(12).text_color(t.ansi1).child(f.err)))
      .child(footer(
        btnCancel("pf-cancel", "取消", (_e, cx) => { this.closeForm(); cx.notify(); }),
        btnPrimary("pf-ok", "确定", true, (cx) => this.submit(cx))));
  }

  render(cx) {
    const t = theme();
    const server = this.currentServer();

    // 本机项目：空态卡片（正常不会进来，按钮已隐藏，只是兜底）。
    if (!server) {
      return v_flex().id("abs-ports").w_full().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
        .child(h_flex().h(32).flex_none().px(9).items_center().border_b(1).border_color(t.border)
          .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("端口转发")))
        .child(div().px(9).py(12).text_size(11.5).text_color(t.dim).child("当前是本机项目，没有远程端口转发。切到远程项目后可管理。"));
    }

    const cfg = this.items.filter((i) => i.source === "config");
    const tun = this.items.filter((i) => i.source === "tunnel");
    const groups = [
      ["配置（生效中）", cfg.filter((i) => i.running)],
      ["配置（未生效）", cfg.filter((i) => !i.running)],
      ["临时（运行中）", tun.filter((i) => i.running)],
      ["临时（已停 / 失败）", tun.filter((i) => !i.running)],
    ];

    return v_flex().id("abs-ports").w_full().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .flex_grow(1).flex_basis(0).min_h(0)
      .child(h_flex().h(32).flex_none().px(9).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("端口转发"))
        .child(div().px(5).rounded(4).bg(t.chrome).text_size(10).text_color(t.muted).child(server.machine))
        .when(this.items.length > 0, (e) => e.child(div().px(5).rounded(4).bg(t.chrome).text_size(10).text_color(t.muted).child(`${this.items.length} 条`)))
        .child(div().flex_1())
        // 新增：放在标题行最右，只有个大 +，不带圆角边框
        .when(!this.form, (e) => e.child(
          h_flex().size(32).flex_none().items_center().justify_center().cursor_pointer()
            .text_color(t.dim)
            .hover((s) => s.text_color(t.foreground))
            .tooltip("新增转发")
            .on_click((_e, cx) => { this.openForm("add"); cx.notify(); })
            .child(svg(icon("plus")).size(20)))))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().child(
        v_flex().px(6).py(5).gap(6).w_full()
          .when(this.note != null, (x) => x.child(div().px(9).py(7).rounded(7).bg(t.raised).border_1().border_color(t.border).text_size(11.5).text_color(t.ansi3).child(this.note)))
          .when(this.loading, (x) => x.child(div().px(3).text_size(11.5).text_color(t.dim).child("读取中…")))
          .when(!this.loading && !this.items.length, (x) => x.child(div().px(3).text_size(11.5).text_color(t.dim).child("这台机器在 ssh 配置里没有端口转发。")))
          .when(Boolean(this.form), (x) => x.child(this.formView(t)))
          .when(!this.form && this.items.length, (x) => x.children(
            groups.filter(([, list]) => list.length).map(([label, list]) =>
              v_flex().gap(6).w_full()
                .child(div().px(2).pt(2).text_size(11).font_semibold().text_color(t.dim).child(label))
                .children(list.map((it) => this.itemRow(it, t))),
            ),
          )),
      ));
  }
}
