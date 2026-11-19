/**
 * 老内核兜底。
 *
 * 起因：Windows 上 WebView2 是跟着系统走的，有的机器停在 109（2023-01）。
 * pdf.js v6 在**模块顶层**执行了一句
 * `typeof Iterator.prototype.join !== "function" && (… = …)`——
 * `Iterator` 是 Chrome 122 才有的全局，老内核上这句直接抛 ReferenceError，
 * 而它在入口 chunk 里，于是整个前端一行都没跑起来，窗口一片黑。
 *
 * 这里只补 pdf.js 真正会用到的两个东西，行为与标准实现一致：
 * - `Iterator`（迭代器助手）
 * - `Promise.withResolvers`
 *
 * 注意：本文件必须在任何业务模块之前求值，所以放在 main.tsx 的第一条 import。
 */

type AnyRecord = Record<string, unknown>;

export function installLegacyPolyfills() {
  const g = globalThis as unknown as AnyRecord;

  if (typeof g.Iterator === "undefined") {
    /*
     * 只实现最小集合：pdf.js 只碰 `Iterator.prototype.join`，
     * 但给一个能用的 `from` 与 `Symbol.iterator`，以后别的库用了也不至于再炸。
     */
    const IteratorShim = class Iterator {
      // 具体迭代器由 from() 或原生对象提供，这里只作为原型宿主
    } as unknown as { prototype: AnyRecord; from?: (obj: unknown) => unknown };

    Object.defineProperty(IteratorShim.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value: function (this: unknown) {
        return this;
      },
    });

    // `[...iter]` 依赖 Symbol.iterator，而 pdf.js 的 join 实现正是 `[...this].join(sep)`
    IteratorShim.from = function (obj: unknown) {
      if (obj && typeof (obj as AnyRecord)[Symbol.iterator as unknown as string] === "function") {
        return obj;
      }
      return obj;
    };

    Object.defineProperty(IteratorShim.prototype, "join", {
      configurable: true,
      writable: true,
      value: function (this: Iterable<unknown>, sep?: string) {
        return Array.from(this).join(sep);
      },
    });

    g.Iterator = IteratorShim;
  }

  if (typeof (Promise as unknown as AnyRecord).withResolvers !== "function") {
    (Promise as unknown as AnyRecord).withResolvers = function <T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
  }
}

/*
 * 导入即生效。
 *
 * 为什么不做成「导出个函数让调用方去调」：pdf.js 在**模块求值阶段**就会碰 `Iterator`，
 * 而函数调用发生在所有 import 求值之后——那时已经晚了。
 * 把副作用放在模块顶层，只要 import 顺序排在业务模块前面就一定先执行。
 */
installLegacyPolyfills();
