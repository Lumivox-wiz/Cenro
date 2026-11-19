import { useCallback, useEffect, useRef, useState } from "react";
import { Delete } from "lucide-react";

interface Props {
  /** 标题，例如「输入 PIN」或「设置 PIN」 */
  title: string;
  hint?: string;
  /** 错误提示（后端返回的原文，例如「PIN 不正确，还可以试 6 次」） */
  error?: string | null;
  busy?: boolean;
  /** 输满 6 位后调用。失败时父组件把 error 传回来，这里自动清空重输。 */
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];
export const PIN_LEN = 6;

/**
 * 6 位 PIN 输入。
 *
 * 手机上主要是数字键盘，桌面上主要是物理键盘——两种都要好用：
 * 数字键 / Backspace / Enter 直接走，屏幕上的九宫格给触屏。
 * 故意不做「输错了抖一下」的动效，抖动的信息量不如一行字。
 */
export default function PinPad({ title, hint, error, busy, onSubmit, onCancel }: Props) {
  const [digits, setDigits] = useState("");
  const submitting = useRef(false);

  // 父组件报错后清空，让用户直接重输
  useEffect(() => {
    if (error) {
      setDigits("");
      submitting.current = false;
    }
  }, [error]);

  /*
   * 换一步就重来。
   *
   * 「设置 PIN」和「再输一次」是同一个组件、同一个位置，React 会连内部 state 一起复用：
   * digits 还是上一遍的 6 位、submitting 还是 true，于是第二遍既输不进去、也不会提交，
   * 界面就停在 6 个圆点那不动了。调用方应该给 key，这里再兜一层。
   */
  useEffect(() => {
    setDigits("");
    submitting.current = false;
  }, [title]);

  const push = useCallback((d: string) => {
    setDigits((prev) => (prev.length >= PIN_LEN ? prev : prev + d));
  }, []);

  /*
   * 输满就提交。
   *
   * 两个坑都在这里躲开了：
   * 1. 不写在 setDigits 的 updater 里 —— updater 必须是纯函数，StrictMode 下会被调两次；
   * 2. 依赖只留 digits，回调走 ref —— 父组件任意一次重渲染都会换掉 onSubmit 的引用，
   *    依赖里带上它就会重跑 effect、顺手把待发的定时器清掉，表现是「点完了没反应」。
   */
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  useEffect(() => {
    if (digits.length !== PIN_LEN || submitting.current) return;
    submitting.current = true;
    // 60ms：让最后一颗圆点先画出来，否则点完立刻跳走，看起来像没反应
    const timer = window.setTimeout(() => submitRef.current(digits), 60);
    return () => {
      window.clearTimeout(timer);
      // 定时器被提前取消（比如立刻按了退格），把锁放回去，别让键盘永远沉默
      submitting.current = false;
    };
  }, [digits]);

  const back = useCallback(() => {
    setDigits((prev) => prev.slice(0, -1));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        push(e.key);
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        back();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [back, onCancel, push]);

  return (
    <div className="pin-pad" role="group" aria-label={title}>
      <div className="pin-title">{title}</div>
      {hint && <div className="pin-hint">{hint}</div>}

      <div className="pin-dots" aria-label={`已输入 ${digits.length} 位，共 ${PIN_LEN} 位`}>
        {Array.from({ length: PIN_LEN }, (_, i) => (
          <span key={i} className="pin-dot" data-filled={i < digits.length} />
        ))}
      </div>

      <div className="pin-error" role="alert">
        {error ?? ""}
      </div>

      <div className="pin-keys">
        {KEYS.map((k, i) =>
          k === "" ? (
            <span key={`gap-${i}`} />
          ) : k === "back" ? (
            <button
              key="back"
              className="pin-key pin-key-fn"
              onClick={back}
              disabled={digits.length === 0 || busy}
              aria-label="删除一位"
            >
              <Delete size={18} strokeWidth={2} />
            </button>
          ) : (
            <button
              key={k}
              className="pin-key"
              onClick={() => push(k)}
              disabled={busy}
            >
              {k}
            </button>
          ),
        )}
      </div>

      <button className="btn btn-ghost" onClick={onCancel}>
        返回书架
      </button>
    </div>
  );
}
