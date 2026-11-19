import { useState, type CSSProperties } from "react";
import { RotateCcw } from "lucide-react";

/*
 * 设置页共用的数值控件。
 *
 * 从 ReadingSettings 里抽出来是因为「背景」页也要用同一套滑杆：
 * 复制一份的话，两处的手感（吸附步长、可编辑数值、单恢复默认）迟早会走散。
 */

/* ---------------- 分组标题 ---------------- */

interface SectionHeadProps {
  title: string;
  /** 该组是否有非默认项；没有时按钮置灰，避免点了没反应 */
  canReset: boolean;
  onReset: () => void;
}

/** 每组标题右侧一个「恢复默认」，作用范围就是这一组，不会波及其它组 */
export function SectionHead({ title, canReset, onReset }: SectionHeadProps) {
  return (
    <div className="section-head">
      <span className="section-title">{title}</span>
      <button
        className="section-reset"
        onClick={onReset}
        disabled={!canReset}
        title={`恢复「${title}」的默认值`}
      >
        恢复默认
      </button>
    </div>
  );
}

/* ---------------- 可编辑数值 ---------------- */

interface NumberValueProps {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** 显示精度：行高 2 位，字号与宽度 0 位 */
  digits?: number;
  onChange: (value: number) => void;
}

/**
 * 数值本身是按钮，点一下变成输入框。
 *
 * 只给滑块时，想从 18 调到 16 得拖两格；知道目标值的用户应该能直接敲。
 * 失焦或回车提交，Esc 放弃，超出量程自动夹到边界并吸附到步长。
 */
export function NumberValue({
  value,
  min,
  max,
  step,
  unit = "",
  digits = 0,
  onChange,
}: NumberValueProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const format = (v: number) => v.toFixed(digits);

  const commit = () => {
    const parsed = Number(draft);
    setEditing(false);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(max, Math.max(min, parsed));
    // 吸附到步长：否则 1.73 这种值会让滑块位置与数值对不上
    const snapped = Math.round(clamped / step) * step;
    onChange(Number(snapped.toFixed(4)));
  };

  if (editing) {
    return (
      <input
        className="field-input"
        autoFocus
        type="text"
        inputMode="decimal"
        value={draft}
        aria-label="输入数值"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            // 设置抽屉在 capture 阶段监听 Esc，不拦住会把整个抽屉关掉
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      className="field-value field-value-edit"
      onClick={() => {
        setDraft(format(value));
        setEditing(true);
      }}
      title="点击直接输入"
    >
      {format(value)}
      {unit}
    </button>
  );
}

/* ---------------- 滑块行 ---------------- */

interface SliderRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  defaultValue: number;
  unit?: string;
  digits?: number;
  /** 该滑杆的适用说明，排在量程下面 */
  hint?: string;
  onChange: (value: number) => void;
}

export function SliderRow({
  label,
  min,
  max,
  step,
  value,
  defaultValue,
  unit = "",
  digits = 0,
  hint,
  onChange,
}: SliderRowProps) {
  const pct = ((value - min) / (max - min)) * 100;
  const changed = Math.abs(value - defaultValue) > 1e-6;

  return (
    <div className="setting-block">
      <div className="setting-head">
        <span className="field-label">{label}</span>
        <span className="field-tail">
          {/* 单项恢复只在偏离默认时出现，平时不占视线 */}
          {changed && (
            <button
              className="field-reset"
              onClick={() => onChange(defaultValue)}
              aria-label={`${label}恢复默认`}
              title={`恢复默认（${defaultValue.toFixed(digits)}${unit}）`}
            >
              <RotateCcw size={12} strokeWidth={2} />
            </button>
          )}
          <NumberValue
            value={value}
            min={min}
            max={max}
            step={step}
            unit={unit}
            digits={digits}
            onChange={onChange}
          />
        </span>
      </div>

      <div className="slider-wrap">
        <input
          className="slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ "--fill": `${pct}%` } as CSSProperties}
          aria-label={label}
          aria-valuetext={`${value.toFixed(digits)}${unit}`}
        />
        {/* 量程必须写出来：只给当前值，用户不知道还能调到哪 */}
        <div className="slider-scale" aria-hidden="true">
          <span>
            {min}
            {unit}
          </span>
          <span>
            {max}
            {unit}
          </span>
        </div>
      </div>

      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

/* ---------------- 单选行 ---------------- */

interface OptionRowProps<T extends string> {
  label: string;
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}

export function OptionRow<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: OptionRowProps<T>) {
  return (
    <div className="setting-block">
      <span className="field-label">{label}</span>
      <div className="option-group" role="group" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            className="option-btn"
            aria-pressed={value === opt.value}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}
