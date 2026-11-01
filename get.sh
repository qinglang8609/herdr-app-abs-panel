#!/bin/sh
# 一键安装：把 ABS 记忆库面板装进 herdr-app。
#
#   curl -fsSL https://raw.githubusercontent.com/qinglang8609/herdr-app-abs-panel/main/get.sh | sh
#
# 做四件事：下载到 ~/.local/share/abs-panel、软链进 herdr-app 的 mods、放图标、切布局。
# 重复运行等于升级，已装过直接再跑一次即可。
set -eu

OWNER_REPO="qinglang8609/herdr-app-abs-panel"
BRANCH="${ABS_PANEL_BRANCH:-main}"
DEST="${ABS_PANEL_HOME:-$HOME/.local/share/abs-panel}"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

say() { printf '%s\n' "$*"; }
die() { say "安装失败：$*" >&2; exit 1; }

# ── 前置检查 ─────────────────────────────
command -v curl >/dev/null 2>&1 || die "需要 curl"
command -v tar >/dev/null 2>&1 || die "需要 tar"
command -v python3 >/dev/null 2>&1 || die "需要 python3（改布局文件用）"

[ -d "$HOME_DIR" ] || die "找不到 herdr-app 配置目录 $HOME_DIR，请先打开一次 herdr-app"

if ! command -v herdr-app >/dev/null 2>&1; then
  say "提醒：没找到 herdr-app 命令，装完后需要手动切到 abs 布局。"
fi

app_version=$(herdr-app --version 2>/dev/null || true)
say "herdr-app: ${app_version:-未检测到}"
say "配置目录: $HOME_DIR"

# ── 下载 ─────────────────────────────────
say "下载 $OWNER_REPO@$BRANCH …"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

url="https://github.com/${OWNER_REPO}/archive/refs/heads/${BRANCH}.tar.gz"
curl -fsSL "$url" -o "$TMP/src.tar.gz" || die "下载失败，检查网络或仓库地址：$url"
tar -xzf "$TMP/src.tar.gz" -C "$TMP" || die "解压失败"

# GitHub 的 tarball 会带一层 <repo>-<branch> 目录，取它。
src=$(find "$TMP" -maxdepth 1 -type d -name '*-*' | head -1)
[ -n "$src" ] || die "解压后找不到源码目录"
[ -f "$src/panel/main.js" ] || die "源码不完整，缺 panel/main.js"

# ── 落盘 ─────────────────────────────────
mkdir -p "$DEST"
# 先拷到临时目录，成工了再换。直接删旧版再拷，拷到一半失败就什么都没有了。
stage="$DEST/.staging"
rm -rf "$stage"
mkdir -p "$stage"
cp -R "$src/panel" "$src/tabs-abs" "$src/detail" "$src/assets" "$stage/" || die "拷贝失败，旧版未动"
[ -f "$stage/panel/main.js" ] || die "拷贝不完整，旧版未动"
# 逐个换：只删一层内容不删目录，正在跑的 mod 软链指向这里。
for item in panel tabs-abs detail assets; do
  rm -rf "$DEST/$item"
  mv "$stage/$item" "$DEST/$item" || die "替换 $item 失败"
done
rmdir "$stage" 2>/dev/null || true
cp -f "$src/install.sh" "$DEST/install.sh"
cp -f "$src/README.md" "$DEST/README.md" 2>/dev/null || true
chmod +x "$DEST/install.sh"

say "已下载到 $DEST"
exec sh "$DEST/install.sh"
