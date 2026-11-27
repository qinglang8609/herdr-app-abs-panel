// 侧栏最底部的统计块：模型用量 + 成功/总请求 + 缓存命中 + 账号 + 签到。
//
// 数据来自自己搭的面板（默认 https://code.d8gx.com）：
//   /api/stats/summary?range=all   overview.tokens / requests / successful / cacheRate、models[]
//   /api/accounts        每个账号的 available / checkedInToday
//
// 时间范围固定取「全部」：不带 range 时服务端默认只给近 7 天，数值会差近 10 倍。
//
// 登录自己管：账号密码换 access(2 小时) + refresh(30 天)，access 快过期就先续期。
// 续期是**轮换**的 —— 每次换出一把新 refresh、寿命重新算 30 天，所以只要这台机器
// 在跑就不会再掉线。旧 refresh 再用一次会被判重放、整条会话链作废，所以新值要
// 原子写回配置文件；写不进去就先用内存里那把，重启后靠账号密码重新登录兜底。
//
// 配置在 ~/.config/herdr-app/agent2api.json，不进任何仓库：
//   { "base": "https://code.d8gx.com", "username": "...", "password": "...", "refresh": "..." }

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, readTextFile, writeTextFile, theme } from "herdr";

const CONFIG = "agent2api.json";
const TOP_MODELS = 5; // 堆叠条最多按几个模型分段
const LEAD_MS = 5 * 60 * 1000; // 提前 5 分钟续期，别卡在边界上
const FALLBACK_TTL = 7200; // 接口没给 expiresIn 时按 2 小时算

// 中文习惯的单位：万 / 亿。
const fmt = (n) => {
  if (n == null) return "—";
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(Math.round(n));
};

// 请求数用千分位，跟面板一致。手写而不用 toLocaleString —— mod 的 JS 引擎没带
// 完整 ICU，toLocaleString("en-US") 出来是 160819 而不是 160,819。
const num = (n) => {
  if (n == null) return "—";
  const s = String(Math.round(Number(n)));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

export default class Stats extends View {
  init(_props, cx) {
    this.data = null;
    this.note = null;
    this.hidden = false; // 没配账号密码/token 就整块不显示
    this.busy = false;
    this.session = null; // { access, refresh, exp }
    this.points = null; // 所有账号的可用积分总数
    this.pointsAt = 0; // 上次取积分的时间（这个 60 秒才拉一次）
    this.refresh(cx);
    // 取数就是两个小请求（summary + accounts，共约 11KB 压缩后），15 秒一次不心疼。
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }

  // 一次 curl，返回 stdout 文本（失败给 null，并把真实原因留到 lastCurlError）。
  async curl(args) {
    const r = await exec("curl", ["-s", "--compressed", "--max-time", "20", ...args]).catch(
      (e) => ({ code: -1, stderr: String(e?.message || e) }),
    );
    if (!r || r.code !== 0) {
      this.lastCurlError = (r?.stderr || r?.stdout || `退出码 ${r?.code}`).trim().slice(0, 120);
      return null;
    }
    return r.stdout;
  }

  async json(url, args = []) {
    const out = await this.curl([...args, url]);
    if (out == null) return null;
    try {
      return JSON.parse(out);
    } catch {
      return null;
    }
  }

  post(url, body, extra = []) {
    return this.json(url, [
      "-X",
      "POST",
      "-H",
      "Content-Type: application/json",
      "-H",
      "x-panel-auth-mode: body",
      ...extra,
      "--data",
      body ?? "",
    ]);
  }

  // 登录与续期返回的形状一样：{ accessToken, refreshToken, expiresIn }。
  take(d) {
    if (!d?.accessToken) return null;
    this.session = {
      access: d.accessToken,
      refresh: d.refreshToken,
      exp: Date.now() + (d.expiresIn ?? FALLBACK_TTL) * 1000,
    };
    return this.session;
  }

  // 轮换出来的 refresh 写回配置。expected 传原来的文本，别人同时改过就写不进去
  // （Stale 会 reject），这一轮放弃、内存里那把照用，下轮重读文件。
  async persist(cfg, raw, refresh) {
    if (!refresh || refresh === cfg.refresh) return;
    cfg.refresh = refresh;
    await writeTextFile(
      `${appHome()}/${CONFIG}`,
      `${JSON.stringify(cfg, null, 2)}\n`,
      raw,
    ).catch(() => null);
  }

  // 要一个能用的 access：内存里没过期就直接用，否则 refresh 换新，再不行账号密码登录。
  async authorize(cfg, raw, base) {
    if (this.session?.access && Date.now() < this.session.exp - LEAD_MS) return this.session.access;

    const rt = this.session?.refresh || cfg.refresh;
    if (rt) {
      const d = (await this.post(`${base}/api/panel/refresh`, "", ["-H", `x-panel-refresh: ${rt}`]))
        ?.data;
      if (this.take(d)) {
        await this.persist(cfg, raw, d.refreshToken);
        return this.session.access;
      }
    }
    if (cfg.username && cfg.password) {
      const resp = await this.post(
        `${base}/api/panel/login`,
        JSON.stringify({ username: cfg.username, password: cfg.password }),
      );
      const d = resp?.data;
      if (this.take(d)) {
        await this.persist(cfg, raw, d.refreshToken);
        return this.session.access;
      }
      // 把真实原因露出来：接口的 error 字段，或 curl 失败时的 stderr，别再只看一句笼统话。
      const reason = resp?.error || resp?.message || this.lastCurlError;
      this.note = reason ? `登录失败：${String(reason).slice(0, 60)}` : "登录失败：检查配置里的账号密码";
      return null;
    }
    // 只贴了旧式 token 的配置也照样能用。
    return cfg.token || null;
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(`${appHome()}/${CONFIG}`).catch(() => null);
        if (!raw) {
          this.hidden = true;
          return;
        }
        const cfg = JSON.parse(raw);
        // 没填账号密码、也没有旧式 token：这块用不上，整块不画。
        if (!(cfg.username && cfg.password) && !cfg.token && !cfg.refresh) {
          this.hidden = true;
          return;
        }
        this.hidden = false;
        const base = String(cfg.base || "https://code.d8gx.com").replace(/\/+$/, "");
        const bearer = (tok) => ["-H", `Authorization: Bearer ${tok}`];

        // 面板报表页用的就是这个汇总接口：一次拿全，不用逐条翻页。
        //   overview -> tokens / requests / successful
        //   models   -> 各模型用量
        //   cacheRates.last10m -> 缓存命中率（面板 tooltip 默认就是近 10 分钟那一档）
        // range=all 对齐面板的「全部」标签，不带就是近 7 天。
        // 账号可用和签到在 /api/accounts 里，两个并发。
        // 401 的响应体也是合法 JSON（{"error":{...}}），不能只看「有没有解析出对象」——
        // 只有带 data 的才算真的拿到了数据，否则按失败处理，才会走到重新登录那一步。
        const pull = async (access) => {
          const [sum, acc] = await Promise.all([
            this.json(`${base}/api/stats/summary?range=all`, bearer(access)),
            this.json(`${base}/api/accounts`, bearer(access)),
          ]);
          return [sum?.data ? sum : null, acc?.data ? acc : null];
        };

        let access = await this.authorize(cfg, raw, base);
        if (!access) {
          if (!(cfg.username && cfg.password) && !cfg.token) { this.hidden = true; return; }
          this.note = this.note ?? "登录失败：检查配置里的账号密码";
          return;
        }
        let [sum, acc] = await pull(access);

        // 两个都空可能是内存里那把刚过期：作废重来一次（会走 refresh 或登录）。
        if (!sum && !acc) {
          this.session = null;
          access = await this.authorize(cfg, raw, base);
          if (access) [sum, acc] = await pull(access);
        }
        if (!sum && !acc) {
          this.note = "取不到数据（登录或续期失败）";
          return;
        }

        const ov = sum?.data?.overview ?? {};
        const topModels = (sum?.data?.models ?? [])
          .map((m) => [m.label || m.model, m.totalTokens || 0])
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_MODELS);
        const list = acc?.data?.accounts ?? [];

        // 可用积分：快照里每个账号有一行 id="account"、label="总积分" 的额度，加总即可。
        // 实时接口 /api/accounts/usage 一次要 4 秒（逐账号查），快照只要 0.15 秒 ——
        // 用快照，而且 60 秒才拉一次（积分变得慢）。
        if (!this.points || Date.now() - this.pointsAt > 60000) {
          const snap = await this.json(`${base}/api/accounts/usage/snapshot`, bearer(access));
          const sources = snap?.data?.quotaSources;
          if (sources) {
            let sum = 0;
            for (const rows of Object.values(sources)) {
              for (const row of rows ?? []) {
                if (row?.id !== "account" || row.unlimited) continue;
                if (typeof row.remaining === "number") sum += row.remaining;
              }
            }
            this.points = sum;
            this.pointsAt = Date.now();
          }
        }

        this.data = {
          tokens: ov.tokens ?? 0,
          topModels,
          // 模型总数：堆叠条要把“前 5 名之外还有多少”写进那一段的悬停提示里
          modelCount: (sum?.data?.models ?? []).length,
          requests: ov.requests ?? 0,
          ok: ov.successful ?? 0,
          // 和面板「缓存命中率」一致：取近 10 分钟那一档，不用全范围的 overview.cacheRate。
          hit: sum?.data?.cacheRates?.last10m?.rate ?? null,
          // available 为 null 表示「这一轮还没查到」，不是不可用；只有 false 才算不可用。
          // enabled=false 是在面板里被禁用的账号，它 available 依旧是 true，但不算可用。
          usable: list.filter((a) => a.enabled !== false && a.available !== false).length,
          accounts: list.length,
          signed: list.filter((a) => a.checkedInToday === true).length,
        };
        this.note = null;
      } catch (e) {
        this.note = String(e?.message || e).slice(0, 48);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();

    // 一个指标：左上名字、右上数值，下面一条进度。
    // 两段用 flex_grow 分配，是真正的百分比，不是写死的像素。
    const row = (name, value, frac, sub, color) => {
      const f = Math.max(0, Math.min(1, frac ?? 0));
      return v_flex()
        .w_full()
        .gap(3)
        .child(
          h_flex()
            .w_full()
            .gap(6)
            .items_center()
            .child(div().text_size(11).text_color(t.dim).child(name))
            .child(div().flex_1())
            .when(Boolean(sub), (el) =>
              el.child(div().text_size(10).text_color(t.dim).child(sub)),
            )
            .child(div().text_size(11).text_color(color ?? t.dim).child(value)),
        )
        .child(
          h_flex()
            .w_full()
            .h(4)
            .rounded(2)
            .overflow_hidden()
            .bg(t.border)
            .child(div().h(4).rounded(2).bg(color ?? t.dim).flex_grow(Math.max(0.015, f))),
        );
    };

    // 段色：跟下面三行的填充色同一套亮度（大红、金、绿、蓝、紫）。
    const TINT = ["#c0503f", "#c99a3e", "#4fbf6b", "#5e8fd8", "#9b6bc8"];

    // 一根堆叠条：按模型占比分段，段加起来正好 100%（顶到右边）。
    // 前 TOP_MODELS 名之外的模型合成一段：只画前几名会剩下一截背景色，
    // 深色主题里 border 和条底色差不多（eva-dark #3e4148 / 底 #282c34），
    // 拿它当填充看着就是一块黑空白。
    const stack = (models, total, count) => {
      const covered = models.reduce((n, [, v]) => n + v, 0);
      const rest = total - covered;
      const tail = Math.max(0, (count || models.length) - models.length);
      const segs = rest > 0
        ? [...models.map(([name, v], k) => [name, v, TINT[k % TINT.length]]), [`其余 ${tail} 个模型`, rest, t.muted]]
        : models.map(([name, v], k) => [name, v, TINT[k % TINT.length]]);
      return h_flex()
        .w_full()
        .h(4)
        .rounded(2)
        .overflow_hidden()
        .bg(t.raised)
        .children(
          segs.map(([name, v, color], k) =>
            div()
              .h(4)
              .bg(color)
              // 只有首尾两段带单边圆角，段与段之间保持直边。
              .when(k === 0, (el) => el.rounded_l(2))
              .when(k === segs.length - 1, (el) => el.rounded_r(2))
              .tooltip(`${name}  ${fmt(v)}${total ? `  ${((v / total) * 100).toFixed(1)}%` : ""}`)
              .flex_grow(Math.max(0.0001, total ? v / total : 0)),
          ),
        );
    };

    // 没配凭据：整块不占位置（布局节点仍在，只是画成空）。
    if (this.hidden) return div().size(0);

    if (!this.data) {
      return v_flex()
        .size_full()
        .px(14)
        .py(12)
        .justify_center()
        .text_size(10.5)
        .text_color(t.dim)
        .child(this.note ?? "读取中…");
    }

    const d = this.data;
    const rate = d.requests ? d.ok / d.requests : null;
    const usable = d.accounts ? d.usable / d.accounts : null;

    return v_flex()
      .size_full()
      .px(14)
      .py(12)
      .gap(5)
      .justify_center()
      // Token：标题 + 数值，下面一根按模型分段的堆叠条
      .child(
        v_flex()
          .w_full()
          .gap(3)
          .child(
            h_flex()
              .w_full()
              .gap(6)
              .items_center()
              .child(div().text_size(11).text_color(t.dim).child("Token"))
              .child(div().flex_1())
              .child(div().text_size(11).text_color(t.dim).child(fmt(d.tokens))),
          )
          .child(stack(d.topModels, d.tokens, d.modelCount)),
      )
      // 请求数据：成功 / 总，条 = 成功率
      .child(row("请求数据", `${num(d.ok)} / ${num(d.requests)}`, rate, null, "#4fbf6b"))
      .child(
        row(
          "缓存命中",
          d.hit == null ? "—" : `${(d.hit * 100).toFixed(1)}%`,
          d.hit,
          null,
          "#e2b45c",
        ),
      )
      .child(
        row(
          "账号可用",
          d.accounts ? `${d.usable}/${d.accounts}` : "—",
          usable,
          null,
          "#8fb1ec",
        ),
      )
      // 可用积分：积分没有天然上限，这条不画进度条，只给数字。
      .child(
        h_flex()
          .w_full()
          .gap(6)
          .items_center()
          .child(div().text_size(11).text_color(t.dim).child("可用积分"))
          .child(div().flex_1())
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(this.points == null ? "—" : num(Math.round(this.points))),
          ),
      )
      .when(Boolean(this.note), (el) =>
        el.child(div().text_size(9.5).text_color(t.ansi1).child(this.note)),
      );
  }
}
