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

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, theme, exec, hc, home, appHome, readTextFile, writeTextFile, notify, terminals } from "herdr";
import { icon, activeSpace } from "./lib.js";

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

// herdr 机器名 → ssh 别名（大小写不敏感，找不到用原名）。
function hostFor(machine, hosts) {
  if (!machine) return hosts[0] ?? null;
  return hosts.find((h) => h.toLowerCase() === machine.toLowerCase()) ?? machine;
}

// ---- 端口占用探测 ---------------------------------------------------------

// 有人监听就返回 { command, pid }，否则 null。
async function portOwner(port) {
  const r = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (r.code !== 0 || !(r.stdout || "").trim()) return null;
  const lines = (r.stdout || "").trim().split("\n");
  const row = lines[1] || lines[0]; // 第一行是表头
  const cols = row.split(/\s+/);
  if (cols.length < 2) return null;
  return { command: cols[0], pid: cols[1] };
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
async function startTunnel(host, localPort, remoteAddr, remotePort, id) {
  const name = `pf-${localPort}-${rand()}`;
  const r = await hc(["run", "--json", "--bg", "--no-parent", "--name", name, "--",
    "ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    "-L", `127.0.0.1:${localPort}:${remoteAddr}:${remotePort}`, host]).catch(() => ({ code: 1, stdout: "" }));
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout).address; } catch { return null; }
}

function stopTunnel(terminal) {
  if (terminal) run("terminal.kill", { terminal });
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
    cx.spawn(async (cx) => {
      await this.cleanup();
      await this.refresh(cx);
      cx.notify();
    });
  }

  // 当前空间所在的远程机器 → ssh 别名；本机返回 null。
  currentHost() {
    const active = activeSpace();
    const machine = active?.machine ?? null;
    if (!machine) return null;
    return hostFor(machine, this.hosts);
  }

  // 打开时清掉记录里 terminal 已消失的项（herdr-core 重启后隧道没了，
  // 只剩死记录）。还在跑的隧道不碰，列表照常显示。
  async cleanup() {
    const tunnels = await readRecord();
    if (!tunnels.length) return;
    const alive = new Set(terminals().map((t) => t.address));
    const kept = tunnels.filter((t) => alive.has(t.terminal));
    if (kept.length !== tunnels.length) await writeRecord(kept);
  }

  refresh(cx) {
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    this.refreshAgain = false;
    cx.spawn(async (cx) => {
      try {
        const configText = await readTextFile(SSH_CONFIG()).catch(() => null);
        const allConfigs = configText ? parseSshConfig(configText) : [];
        this.hosts = configText ? configHosts(configText) : [];
        // 只留当前远程机器的转发；本机项目则列表为空。
        const host = this.currentHost();
        const configs = host ? allConfigs.filter((c) => c.host.toLowerCase() === host.toLowerCase()) : [];
        const allTunnels = await readRecord();
        const tunnels = host ? allTunnels.filter((t) => String(t.host ?? "").toLowerCase() === host.toLowerCase()) : [];
        const terms = terminals();
        const byAddr = new Map(terms.map((t) => [t.address, t]));

        // 先探测所有相关端口，再组装。
        const ports = new Set([...configs.map((c) => c.localPort), ...tunnels.map((t) => t.localPort)]);
        const owners = new Map();
        const descCache = new Map(); // pid -> 描述，同 pid 只 ps 一次
        for (const p of ports) {
          const o = await portOwner(p);
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
          const owner = owners.get(t.localPort);
          const termLive = Boolean(term && term.state === "live");
          const running = termLive && Boolean(owner);
          const stopped = Boolean(t.stopped);
          const dead = !term; // 终端消失（herdr-core 重启）
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
    const active = activeSpace();
    const machine = active?.machine ?? null;
    const host = mode === "add" ? hostFor(machine, this.hosts) : item.host;
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
    stopTunnel(terminal);
    throw new Error(out ? `启动失败：${out.split("\n")[0]}` : `端口 ${lp} 未监听`);
  }

  async doAdd(host, lp, remoteAddr, rp) {
    const id = `pf-${rand()}`;
    const terminal = await this.launchAndRecord(host, lp, remoteAddr, rp, id);
    const tunnels = await readRecord();
    tunnels.push({ id, host, localPort: lp, remoteAddr, remotePort: rp, terminal, stopped: false, note: null });
    await writeRecord(tunnels);
  }

  async doEditTunnel(item, host, lp, remoteAddr, rp) {
    const same = host === item.host && lp === Number(item.localPort) && remoteAddr === (item.remoteAddr ?? "127.0.0.1") && rp === Number(item.remotePort);
    if (same) return;
    const old = { terminal: item.terminal, running: item.running, host: item.host, localPort: item.localPort, remoteAddr: item.remoteAddr, remotePort: item.remotePort };
    // 旧隧道先停（改端口/主机要重起；本机端口没变时新隧道会因端口占用失败，所以一律先停）。
    if (item.terminal) stopTunnel(item.terminal);
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
    if (x) { x.host = host; x.localPort = lp; x.remoteAddr = remoteAddr; x.remotePort = rp; x.terminal = terminal; x.stopped = false; x.note = null; }
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
      if (it.source === "tunnel" && it.terminal) {
        stopTunnel(it.terminal);
        await waitFree(it.localPort);
      }
      const id = it.source === "config" ? `pf-${rand()}` : it.id;
      const terminal = await this.launchAndRecord(it.host, Number(it.localPort), it.remoteAddr, Number(it.remotePort), id);
      const tunnels = await readRecord();
      if (it.source === "config") {
        tunnels.push({ id, host: it.host, localPort: it.localPort, remoteAddr: it.remoteAddr, remotePort: it.remotePort, terminal, stopped: false, note: null });
      } else {
        const x = tunnels.find((t) => t.id === it.id);
        if (x) { x.terminal = terminal; x.stopped = false; x.note = null; }
      }
      await writeRecord(tunnels);
    });
  }

  stopItem(it, cx) {
    this.act(cx, async () => {
      stopTunnel(it.terminal);
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
        stopTunnel(it.terminal);
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

  field(label, state) {
    const t = theme();
    return v_flex().gap(4)
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(
        h_flex().h(30).px(9).items_center().rounded(7).border_1().border_color(t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(state).h_full().text_size(12.5).text_color(t.foreground)),
      );
  }

  formView(t) {
    const f = this.form;
    if (!f) return null;
    const lockHost = f.mode === "edit-config";

    const hostsList = this.hosts.length
      ? this.hosts.map((h) =>
          h_flex().px(8).py(5).rounded(6).text_size(12).text_color(t.foreground).cursor_pointer()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .hover((s) => s.bg(t.selected))
            .when(h === f.host, (e) => e.bg(t.hover))
            .on_click((_e, cx) => { f.host = h; f.hostOpen = false; cx.notify(); })
            .child(h))
      : [div().px(8).py(5).text_size(12).text_color(t.dim).child("ssh config 里没有 Host")];

    return v_flex().gap(10).w_full()
      .child(div().text_size(14).font_semibold().child(
        f.mode === "add" ? "新增转发" : f.mode === "edit-config" ? `改 ${f.item.host} 的端口` : "编辑转发"))
      .child(
        v_flex().gap(4)
          .child(div().text_size(11).text_color(t.dim).child("主机（ssh 别名）"))
          .child(
            h_flex().h(30).px(9).items_center().rounded(7).border_1().border_color(t.border)
              .justify_between()
              .when(!lockHost, (e) => e.cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { f.hostOpen = !f.hostOpen; cx.notify(); }))
              .child(div().text_size(12.5).text_color(t.foreground).child(f.host ?? "—"))
              .when(!lockHost, (e) => e.child(svg(icon("chevron-down")).size(12).text_color(t.dim))),
          )
          .when(!lockHost && f.hostOpen, (e) => e.child(
            v_flex().mt(2).p(4).rounded(7).border_1().border_color(t.border).max_h(160).overflow_y_scrollbar().children(hostsList),
          )),
      )
      .child(this.field("本机端口（127.0.0.1）", this.inputLocal))
      .when(!lockHost, (e) => e
        .child(this.field("远程地址", this.inputRemoteAddr))
        .child(this.field("远程端口", this.inputRemotePort)))
      .when(lockHost, (e) => e.child(div().text_size(11).text_color(t.dim)
        .child(`远程目标：${f.item.remoteAddr ?? "?"}:${f.item.remotePort ?? "?"}（只改本机端口）`)))
      .when(f.err, (e) => e.child(div().px(9).py(6).rounded(7).bg(t.raised).border_1().border_color(t.ansi1).text_size(12).text_color(t.ansi1).child(f.err)))
      .child(
        h_flex().justify_end().gap(8)
          .child(h_flex().h(30).px(12).items_center().rounded(8).border_1().border_color(t.input)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .text_color(t.foreground).cursor_pointer().on_click((_e, cx) => { this.closeForm(); cx.notify(); }).child("取消"))
          .child(h_flex().h(30).px(14).items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .cursor_pointer().on_click((_e, cx) => this.submit(cx)).child("确定")),
      );
  }

  render(cx) {
    const t = theme();
    const host = this.currentHost();

    // 本机项目：空态卡片（正常不会进来，按钮已隐藏，只是兜底）。
    if (!host) {
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
        .child(div().px(5).rounded(4).bg(t.chrome).text_size(10).text_color(t.muted).child(host))
        .when(this.items.length > 0, (e) => e.child(div().px(5).rounded(4).bg(t.chrome).text_size(10).text_color(t.muted).child(`${this.items.length} 条`)))
        .child(div().flex_1()))
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
      ))
      .when(!this.form, (e) => e.child(
        h_flex().px(9).pb(8).pt(4).flex_none()
          .child(h_flex().h(28).px(10).items_center().gap(5).rounded(7).cursor_pointer()
            .text_size(11.5).text_color(t.dim).border_1().border_color(t.border)
            .hover((s) => s.bg(t.chrome).text_color(t.foreground))
            .on_click((_e, cx) => { this.openForm("add"); cx.notify(); })
            .child(svg(icon("plus")).size(12)).child("新增转发")),
      ));
  }
}
