#!/bin/sh
# 把本目录的面板和改动装进 herdr-app。
# 已经装过的直接重跑即可：软链接重建，布局与面板开关写回配置。
set -e

SRC=$(cd "$(dirname "$0")" && pwd)
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS="$HOME_DIR/mods"

[ -d "$HOME_DIR" ] || { echo "找不到 herdr-app 配置目录：$HOME_DIR" >&2; exit 1; }
[ -f "$HOME_DIR/layouts/main.json" ] || { echo "缺 layouts/main.json，请先打开一次 herdr-app 让它生成出厂布局" >&2; exit 1; }

mkdir -p "$MODS" "$HOME_DIR/layouts"

# 面板与改过的标签栏都用软链接，改源码立刻生效，不往配置目录里复制代码。
ln -sfn "$SRC/panel" "$MODS/abs-panel"
ln -sfn "$SRC/tabs-abs" "$MODS/tabs-abs"
ln -sfn "$SRC/detail" "$MODS/abs-detail"

# 图标按应用根目录解析（gpui-kit 的 image()/svg() 都这样），所以放在 app home 下，
# 不能放在 mod 目录里。
# 要复制而不是软链：image() 读不了软链接，会画成空方块。
mkdir -p "$HOME_DIR/abs-icons"
cp -f "$SRC/assets/zed.svg" "$HOME_DIR/abs-icons/zed.svg"
cp -f "$SRC/assets/vscode.svg" "$HOME_DIR/abs-icons/vscode.svg"

# 布局：从出厂 main 重新生成 abs.json（右侧栏多一块 abs-panel，标签栏换成 tabs-abs）。
# 每次都重新生成：旧版装过也能升上来。你自己改过的窗口尺寸等在 layouts/.state/ 里，不受影响。
cp "$HOME_DIR/layouts/main.json" "$HOME_DIR/layouts/abs.json"
python3 - "$HOME_DIR/layouts/abs.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))

def find(node, want):
    if isinstance(node, dict):
        if node.get("id") == want:
            return node
        for child in node.get("children") or []:
            hit = find(child, want)
            if hit:
                return hit
    return None

stack = find(d, "panel-body")
if not any(c.get("id") == "abs" for c in stack["children"]):
    stack["children"].append({"id": "abs", "type": "block", "content": {"mod": "abs-panel"}})
tabs = find(d, "tabs")
tabs["content"]["mod"] = "tabs-abs"
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PY

# 切到 abs 布局，用 app 自己的命令，不直改 shared.json：
# 那个文件 app 也在写，两边同时写会互相覆盖（实测会丢掉 Files 按钮）。
if command -v herdr-app >/dev/null 2>&1; then
  herdr-app do layout.switch --name abs >/dev/null 2>&1 || true
fi

echo "装好了。重启 herdr-app 后右上角出现「记忆库」按钮。"
