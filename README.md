# abs（herdr-app 界面）

一套完整的 herdr-app 界面：左侧工作区列表、顶栏、右侧记忆库面板。
装完和仓库里的一模一样。

## 一键安装

```sh
curl -fsSL https://raw.githubusercontent.com/qinglang8609/herdr-app-abs-panel/main/get.sh | sh
```

重复运行等于升级。

已经 clone 的，直接跑：

```sh
sh install.sh
```

装完重启 herdr-app。

## 界面

```
┌─────────────┬───────────────────────────┬──────────────┐
│ ⚙  ⊟        │ π - fanchao  …    </> 📄▤⌗🕐│              │
│             ├───────────────────────────┤  pi 会话  58 │
│ New thread  │                           │ ┌──────────┐ │
│ Search      │       终端                 │ │标题      │ │
│ Add machine │                           │ │日期 大小 │ │
│             │                           │ └──────────┘ │
│ Spaces      │                           │      …       │
│  本机       │                           │ ┌──────────┐ │
│  ~          │                           │ │ ‹ Prev   │ │
│  abs        │                           │ │ 1/3 Next │ │
│  fnos       │                           │ └──────────┘ │
│   root      │                           │              │
│ Agents      │                           │              │
│  Working 1  │                           │              │
└─────────────┴───────────────────────────┴──────────────┘
```

顶栏右上角四个图标切换右侧面板：会话、看板、图谱、日志。点已打开的那个收起。

## 结构

```
mods/abs/                 整套界面，一个模块
├── main.js               按 part 分发
├── icons/                53 个图标
├── parts/
│   ├── side.js           侧栏顶栏 + 三行导航
│   ├── head.js           顶栏、打开菜单、页面图标
│   ├── spaces.js         工作区列表（按服务器分组）
│   ├── agents.js         Agents 运行状态
│   ├── panel.js          右侧记忆库面板
│   ├── space-icon.js     右键换工作区图标
│   ├── foot.js           底部设置与主题
│   ├── lib.js            公共工具
│   └── space-icons.js    工作区图标名单
└── scripts/scan.js       会话扫描

detail/                   点任务弹出的详情框
themes/                   atom-one-dark 等主题
layouts/abs.json          布局
```

布局只引用 `mods/abs` 一个模块，靠 `props.part` 取不同的块：

| part | 位置 |
|---|---|
| `side-top` | 侧栏顶栏（齿轮、折叠） |
| `sidebar` | New thread / Search / Add machine |
| `spaces` | 工作区列表 |
| `agents` | 左下 Agents |
| `header` | 顶栏 |
| `panel` | 右侧记忆库面板 |

弹窗（不占布局位置）：`open-menu`、`quick-open`、`space-icon`。

## 右侧面板

四个页签，数据结构都从当前项目的 `.brain` 读：

- **会话**：`~/.local/share/abs-panel` 下的 pi 会话缓存。两行一条，悬停右侧出现 × 删除，每页 20 条
- **看板**：`todo.md` 的任务。进行中在上（为 0 就不显示），已完成在下；`[[log-日期]]` 双链会展开成 `sessions/*.md` 里的真实任务；整张卡片一起滚，翻页固定在底部
- **图谱**：`index.md` 的铁律与分类索引
- **日志**：`log.md` 的记录，三行一条（标题 / 详情 / 作者+时间），翻页固定在底部

状态色：进行中深绿、讨论中橙、滞留/搁置/暂停红，都是白字。

## 刷新

只刷当前页：会话/看板读 `todo.md`，图谱读 `index.md`，日志读 `log.md`。
读到才替换，读不到保留旧列表（不会先变空）。切走就停 5 秒定时器，切回先刷一次再起表。

## 主题

`atom-one-dark` 已补齐 `colors` 里的 `canvas`、`surface`、`chrome`、`raised`、`hover`、`selected`、`border`，
让终端、窗口、侧栏、卡片底色分层一致。
