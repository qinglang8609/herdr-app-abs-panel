#!/bin/sh
# 把 abs 这套界面装进 herdr-app：侧栏面板 + 文件树弹窗 + Git 面板 + 用量统计块。
# 已经装过的直接重跑即可：模块覆盖，布局与主题写回配置。
set -e

SRC=$(cd "$(dirname "$0")" && pwd)
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS="$HOME_DIR/mods"

[ -d "$HOME_DIR" ] || { echo "找不到 herdr-app 配置目录：$HOME_DIR" >&2; exit 1; }
[ -f "$HOME_DIR/layouts/main.json" ] || { echo "缺 layouts/main.json，请先打开一次 herdr-app 让它生成出厂布局" >&2; exit 1; }

mkdir -p "$MODS" "$HOME_DIR/layouts" "$HOME_DIR/themes"

# abs：整套界面一个模块。复制而不是软链——里面带 svg 图标，
# image() 读不了软链接（会画成空方块）。
for m in abs agent2api changes-mine files-mine; do
  [ -d "$SRC/mods/$m" ] || continue
  rm -rf "$MODS/$m"
  cp -R "$SRC/mods/$m" "$MODS/$m"
done

# abs-detail：点任务/铁律弹出的详情对话框。软链接，改源码立刻生效。
ln -sfn "$SRC/detail" "$MODS/abs-detail"

# 主题：覆盖同名文件，别的不动。
for t in "$SRC"/themes/*.json; do
  [ -f "$t" ] || continue
  cp -f "$t" "$HOME_DIR/themes/$(basename "$t")"
done

# 布局：直接用仓库里这份 abs.json（不现场生成，界面才和仓库一致）。
# 备份旧的，免得你自己的改动无声丢掉。
if [ -f "$HOME_DIR/layouts/abs.json" ]; then
  cp "$HOME_DIR/layouts/abs.json" "$HOME_DIR/layouts/abs.json.before-install"
fi
cp -f "$SRC/layouts/abs.json" "$HOME_DIR/layouts/abs.json"

# agent2api 的面板凭据：没配置文件才生成模板，已有的不动。
if [ ! -f "$HOME_DIR/agent2api.json" ]; then
  cp "$SRC/agent2api.example.json" "$HOME_DIR/agent2api.json"
  chmod 600 "$HOME_DIR/agent2api.json"
  echo "已生成 $HOME_DIR/agent2api.json —— 把面板地址和账号密码填进去。"
fi

# 切到 abs 布局。用 app 自己的命令，不直改 shared.json：
# 那个文件 app 也在写，两边同时写会互相覆盖。
if command -v herdr-app >/dev/null 2>&1; then
  herdr-app do layout.switch --name abs >/dev/null 2>&1 || true
fi

echo "装好了：abs / agent2api / changes-mine / files-mine，布局 abs。重启 herdr-app 生效。"
