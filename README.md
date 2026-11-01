# ABS 记忆库面板（herdr-app）

给 herdr-app 的标签栏（右上角，Files / Changes 旁边）加一个「记忆库」按钮，
点开在右侧栏用卡片展示当前项目 `.brain` 的 index / todo / log。

## 界面

```
标签栏                                    [+  New]  [Files] [Changes] [记忆库]
                                                                     ↓ 点
右侧 368px 面板
┌─────────────────────────────────────────┐
│ ABS 记忆库   [看板] 图谱  日志     刷新  │
├─────────────────────────────────────────┤
│ ┌ 看板  1 进行中 ─────────────────────┐ │
│ │ [滞留中] herdr-app-pane-ratio-api    │ │
│ │ herdr-app 分栏比例快捷键不可行…      │ │
│ ├ 最近完成 2 条 ─────────────────────┤ │
│ │ [落地] copy-herdr-tui-config +1 子项 │ │
│ └─────────────────────────────────────┘ │
│ ┌ 最近日志  27 条 ────────────────────┐ │
│ │ [dev] 2026-09-10 10:33               │ │
│ │ herdr 分栏比例快捷键：layout.set_…   │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ /Users/fanchao/.brain                   │
└─────────────────────────────────────────┘
```

三个页签各自显示的内容：

| 页签 | 卡片 |
|---|---|
| 看板 | 进行中任务 + 最近完成 5 条；主任务下缩进列出子项（最多 3 条，带各自完成状态） |
| 图谱 | index.md 各分类页数、规则条数，点分类看全部条目 |
| 日志 | log.md 最新 12 条（类型、时间、正文） |

## 卡片怎么读

三色圆点在每张卡片左上角：

| 颜色 | 含义 |
|---|---|
| 绿 | 进行中 |
| 红 | 暂停（滞留中 / 搁置 / 讨论中） |
| 橙 | 完成 |

卡片上任务名最大，第二行是说明摘要。点任意卡片弹出详情窗，能看到全文、子项清单和 md 原始行。

## 右下角两个按钮

| 按钮 | 本地项目 | 远程项目 |
|---|---|---|
| Zed | `zed <目录>` | `zed ssh://<ssh别名><目录>` |
| VSCode | `code <目录>` | `code --remote ssh-remote+<ssh别名> <目录>` |

herdr-app 里的机器名（`fnos`）和 `~/.ssh/config` 的别名（`FNOS`）大小写不一样，
所以会先查 `hc machine ls` 拿 `target`，拿到哪个用哪个。

图标在 `assets/`，安装时软链到 `~/.config/herdr-app/abs-icons/`。
必须放应用根目录下：gpui-kit 的 `svg()` / `image()` 路径是按应用根目录解析的，放 mod 目录里读不到。

## 刷新时机

| 触发 | 行为 |
|---|---|
| 切空间 / 切 pane / 工作目录变了 | 立刻重读，不等定时器 |
| `.brain` 里文件改了（仅本机） | 监听目录，改完就重读 |
| 每 5 秒 | 定时重读一次，远程机器只能靠这一条 |
| 点「刷新」 | 手动重读 |

## 读哪台机器

跟随当前空间：空间在 `fnos` 上，就读 `fnos` 上的 `.brain`。
先按工作目录往上找 `.brain`，找不到再用那台机器的 `~/.brain`（远程的 `HOME` 是问远程 `sh` 拿的，不用本地的）。
远程连不上时面板会写明「连不上 xxx」，不会悄悄显示本地数据顶替。

面板底部那一行写着实际读的目录，远程带机器名前缀，例如 `fnos:/vol1/1000/docker/.brain`。

## 目录

| 路径 | 作用 |
|---|---|
| `panel/` | 面板 mod 本体（`main.js` + `mod.json` + `brain.svg`） |
| `tabs-abs/` | 出厂 tabs 的副本，加了「记忆库」按钮 |
| `install.sh` | 装进 herdr-app（布局由脚本从出厂 main 生成，不入库） |

## 安装

### 一键装（推荐，装到别的电脑用这个）

```sh
curl -fsSL https://raw.githubusercontent.com/qinglang8609/herdr-app-abs-panel/main/get.sh | sh
```

代码放到 `~/.local/share/abs-panel`，然后软链进 herdr-app、放图标、切布局。
装完右上角就有「记忆库」按钮，没有就重启一次 app。再跑同一条命令等于升级。

需要 `curl`、`tar`、`python3`，以及已经装好并至少打开过一次 herdr-app。

| 环境变量 | 作用 |
|---|---|
| `HERDR_APP_HOME` | herdr-app 配置目录，默认 `~/.config/herdr-app` |
| `ABS_PANEL_HOME` | 代码放哪，默认 `~/.local/share/abs-panel` |
| `ABS_PANEL_BRANCH` | 装哪个分支，默认 `main` |

### 从源码装（自己改代码时用）

```sh
./install.sh
```

和上面等价，但直接用当前目录的文件，改 `panel/main.js` 立即生效。

### 出问题怎么查

```sh
herdr-app check ~/.config/herdr-app/mods/abs-panel   # 面板能不能加载
herdr-app status                                     # 看 layout 和 errors
```

`errors` 不为空就看它写的原因。改完 mod 代码界面没变，重启 app：

```sh
osascript -e 'quit app "Herdr"' && open -a Herdr
```

## 为什么这么改

herdr-app 的 `herdr-plugin.toml` 插件系统只出终端界面，画不了真卡片；
它真正可改的是 `~/.config/herdr-app/` 下的布局、mod（gpui-kit JavaScript）和快捷键，
所以面板写成 mod，按钮写成 tabs mod 的副本。

出厂布局和 mod 每次启动都会被覆盖，所以一律用副本：
`abs.json` 与 `tabs-abs` 都是个人文件，不会被动。

## 已知问题

- 面板开合按空间记忆，新空间第一次是关的，点一下「记忆库」按钮打开即可。
- 远程机器上的 `.brain` 没有文件监听，只能靠 5 秒一次的重读发现改动。
- 面板底部路径栏空间有限，很长的路径会截断成 `.../herdr/.b...`。
