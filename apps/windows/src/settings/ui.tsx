// Small glass controls for the Settings window, in the notch's language (`.sheet`, hairlines, the state palette).
import type { ReactNode } from "react"
import { toggleCue, uiCue } from "../sound"

/** A page: its title and one line on what it holds (the Mac's ReloSettingsTitle), with the orb on Relo's own page. */
export function Page({ title, detail, orb, children }: { title: string; detail: string; orb?: boolean; children: ReactNode }) {
  return (
    <div className="page">
      <div className="page-title">
        {orb && <span className="orb" style={{ ["--s" as string]: "34px" }} aria-hidden />}
        <div className="page-title-text">
          <h1>{title}</h1>
          <p>{detail}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

export function Group({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  return (
    <section>
      {title && <h2 className="group-title">{title}</h2>}
      <div className="sheet" style={{ overflow: "hidden" }}>
        {children}
      </div>
      {footer && <p className="group-foot">{footer}</p>}
    </section>
  )
}

export function Row({ title, detail, disabled, children }: { title: ReactNode; detail?: ReactNode; disabled?: boolean; children?: ReactNode }) {
  return (
    <div className="row" data-disabled={disabled ? "" : undefined}>
      <div className="row-text">
        <div className="row-title">{title}</div>
        {detail && <div className="row-detail">{detail}</div>}
      </div>
      {children}
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => {
        onChange(!checked)
        // After the change, so switching sounds off is silent and switching them on is heard.
        uiCue(toggleCue(!checked))
      }}
    />
  )
}

/** A tick box (an agent in a list): the same rising or falling cue as a switch. */
export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className="check"
      onClick={() => {
        onChange(!checked)
        uiCue(toggleCue(!checked))
      }}
    >
      {checked && (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#0b0b12" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
        </svg>
      )}
    </button>
  )
}

/** A row with a title (and detail) and its switch. */
export function ToggleRow({ title, detail, checked, onChange, disabled }: { title: string; detail?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Row title={title} detail={detail} disabled={disabled}>
      <Switch checked={checked} onChange={onChange} label={title} />
    </Row>
  )
}

export function Btn({ children, onClick, primary, disabled }: { children: ReactNode; onClick?: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className="btn" data-primary={primary ? "" : undefined} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}

export function Select<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <select className="select" aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Slider({ value, min, max, step, onChange, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string }) {
  const p = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0
  return <input className="range" type="range" aria-label={label} min={min} max={max} step={step} value={value} style={{ ["--p" as string]: `${p}%` }} onChange={(e) => onChange(Number(e.target.value))} />
}
