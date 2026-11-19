import { useCallback, useEffect, useState } from "react";
import { Lock, LockOpen, ShieldCheck } from "lucide-react";
import { errorText, privacyApi, type PrivacyStatus } from "../../api";
import PinPad from "../privacy/PinPad";

interface Props {
  onToast: (text: string, tone?: "info" | "danger") => void;
  /** 状态变化后通知外壳（隐私书进出的入口都在书架，设置页只负责开关） */
  onChanged: () => void;
  /**
   * 打开隐私书架。
   *
   * 手机上顶栏把品牌名「岑序」隐藏了（那一行要塞搜索、筛选、导入、设置），
   * 而长按入口就挂在那两个字上——所以手机上必须有一条显式入口，
   * 否则功能等于不存在。桌面保留长按，这里对两端都管用。
   */
  onOpenShelf: () => void;
}

const LOCK_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "1 分钟" },
  { value: 5, label: "5 分钟" },
  { value: 15, label: "15 分钟" },
  { value: 0, label: "不自动锁" },
];

type Step = "idle" | "set-pin" | "confirm-pin" | "disable";

/**
 * 隐私设置：只负责「开 / 关 / 自动上锁」。
 *
 * 书架里的书进进出出都在隐私书架里做，设置页不放「批量移入」——
 * 这个页面是给未来的自己看的，越简单越好。
 */
export default function PrivacySettings({ onToast, onChanged, onOpenShelf }: Props) {
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [firstPin, setFirstPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await privacyApi.status());
    } catch {
      /* 非 Tauri 环境 */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reset = useCallback(() => {
    setStep("idle");
    setFirstPin("");
    setError(null);
  }, []);

  const enable = useCallback(
    async (pin: string) => {
      setBusy(true);
      setError(null);
      try {
        await privacyApi.enable(pin, status?.lock_after_minutes ?? 5);
        reset();
        await refresh();
        onChanged();
        onToast("隐私书架已启用");
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onToast, refresh, reset, status],
  );

  const disable = useCallback(
    async (pin: string) => {
      setBusy(true);
      setError(null);
      try {
        await privacyApi.disable(pin);
        reset();
        await refresh();
        onChanged();
        onToast("隐私书架已关闭");
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onToast, refresh, reset],
  );

  // 改超时不需要 PIN：它不改变「谁能看到」，只改变「多久之后要再输一次」
  const setLockAfter = useCallback(
    async (minutes: number) => {
      try {
        await privacyApi.setLockAfter(minutes);
        await refresh();
      } catch (e) {
        onToast(errorText(e), "danger");
      }
    },
    [onToast, refresh],
  );

  const enabled = status?.enabled ?? false;

  if (step === "set-pin") {
    return (
      <PinPad
        key="set-pin"
        title="设置 PIN"
        hint="6 位数字。忘记就没有找回通道，书会打不开。"
        error={error}
        busy={busy}
        onSubmit={(pin) => {
          setFirstPin(pin);
          setError(null);
          setStep("confirm-pin");
        }}
        onCancel={reset}
      />
    );
  }

  if (step === "confirm-pin") {
    return (
      <PinPad
        key="confirm-pin"
        title="再输一次"
        hint="确认刚才的 PIN"
        error={error}
        busy={busy}
        onSubmit={(pin) => {
          if (pin !== firstPin) {
            setError("两次输入不一致，请重新设置");
            setFirstPin("");
            setStep("set-pin");
            return;
          }
          void enable(pin);
        }}
        onCancel={reset}
      />
    );
  }

  if (step === "disable") {
    return (
      <PinPad
        key="disable"
        title="输入 PIN 关闭"
        hint="书架里还有书时不能关闭"
        error={error}
        busy={busy}
        onSubmit={(pin) => void disable(pin)}
        onCancel={reset}
      />
    );
  }

  return (
    <>
      <section className="drawer-section">
        <div className="section-title">隐私书架</div>

        <div className="field-row">
          <span className="field-label">状态</span>
          <span className="field-value">
            {!enabled ? (
              "未启用"
            ) : (
              <span className="privacy-state">
                {status?.unlocked ? (
                  <>
                    <LockOpen size={13} strokeWidth={2} aria-hidden="true" /> 已解锁
                  </>
                ) : (
                  <>
                    <Lock size={13} strokeWidth={2} aria-hidden="true" /> 已锁定
                  </>
                )}
              </span>
            )}
          </span>
        </div>

        {enabled && (
          <>
            <div className="field-row">
              <span className="field-label">书架里的书</span>
              <span className="field-value">
                {status?.unlocked ? `${status.private_books} 本` : "—"}
              </span>
            </div>
            <div className="field-row">
              <span className="field-label">自动上锁</span>
              <select
                className="settings-select"
                value={status?.lock_after_minutes ?? 5}
                onChange={(e) => void setLockAfter(Number(e.target.value))}
              >
                {LOCK_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {enabled && (
          <div className="option-group">
            <button className="btn btn-primary" onClick={onOpenShelf}>
              打开隐私书架
            </button>
          </div>
        )}

        <div className="option-group">
          {!enabled ? (
            <button className="btn btn-secondary" onClick={() => setStep("set-pin")}>
              <ShieldCheck size={16} strokeWidth={2} />
              启用隐私书架
            </button>
          ) : (
            <button className="btn btn-secondary" onClick={() => setStep("disable")}>
              关闭隐私书架
            </button>
          )}
        </div>

        <div className="field-hint">
          入口：手机与桌面都可以从这里点「打开隐私书架」；桌面还可以在书架顶部标题
          「岑序」上长按 0.8 秒。锁定时，隐私书不出现在书架、搜索、统计里，
          也不会进备份，封面挪到单独的目录。
          <br />
          这一版**不加密文件**：书仍在磁盘上，书名仍是文件名。它挡的是「别人拿起你的设备翻两下」，
          挡不住任何懂电脑的人。
          <br />
          忘记 PIN：关闭应用后删掉数据目录里的 <code>privacy.json</code>，隐私书架回到未启用状态；
          那些书仍标着隐私，打开隐私书架（此时不再要 PIN）逐本「移出」即可。
        </div>
      </section>
    </>
  );
}
