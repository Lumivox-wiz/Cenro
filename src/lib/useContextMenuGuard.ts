import { useEffect } from "react";

/**
 * 抑制 WebView 的默认右键菜单。
 *
 * WebView2 在页面任意位置右键都会弹出浏览器菜单（返回 / 刷新 / 另存为 / 打印），
 * 这对一个本地阅读器来说是噪音，而且「刷新」会把整页重载、状态全丢。
 * Tauri 没有关闭它的配置项，只能在事件层拦。
 *
 * 保留两类原生菜单，否则会影响正常使用：
 * - 输入框 / 可编辑区域：没有系统菜单就无法粘贴、拼写检查
 * - 存在文字选区：阅读页选中一段文字后要复制
 *
 * 书架上书籍卡片的自定义菜单由组件自身 preventDefault 后渲染，不受影响。
 */
export function useContextMenuGuard() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      if (target.closest("input, textarea, [contenteditable='true']")) return;

      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
        return;
      }

      e.preventDefault();
    };

    // 捕获阶段拦在最前面，避免任何组件在冒泡中途又把它放行
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
  }, []);
}
