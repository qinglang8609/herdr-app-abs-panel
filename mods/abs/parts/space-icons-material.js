// 工作区图标可选的彩色图标（来自 material-icon-theme，跟 files 面板同一套）。
// 路径实际在 mods/files-mine/icons/ 下，选择器渲染时用 image() 才会保留颜色。
export const SPACE_ICON_FILES = [
  "folder-api.svg",
  "folder-app.svg",
  "folder-src.svg",
  "folder-components.svg",
  "folder-config.svg",
  "folder-docker.svg",
  "folder-docs.svg",
  "folder-images.svg",
  "folder-scripts.svg",
  "folder-test.svg",
  "folder-node.svg",
  "folder-git.svg",
  "folder-github.svg",
  "folder-database.svg",
  "folder-dist.svg",
  "folder-public.svg",
  "folder-layout.svg",
  "folder-views.svg",
  "folder-controller.svg",
  "folder-middleware.svg",
  "folder-utils.svg",
  "folder-hook.svg",
  "folder-lib.svg"
];

// 存进 shared 时带这个前缀，渲染时才知道该走 image() 还是单色 svg()。
export const MATERIAL_PREFIX = "material/";

export const isMaterialIcon = (name) => String(name ?? "").startsWith(MATERIAL_PREFIX);
export const materialPath = (name) => `mods/files-mine/icons/${String(name).slice(MATERIAL_PREFIX.length)}`;
