import { useId } from 'react'

/**
 * Controlled numeric text input accepting comma as decimal separator
 * (Polish users, PRD §5.4). Parsing/validation happens in the page state —
 * this component renders the raw string and an optional inline error.
 */
export interface NumberFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  error?: string | undefined
  suffix?: string
  placeholder?: string
  disabled?: boolean
}

export function NumberField({ label, value, onChange, error, suffix, placeholder, disabled }: NumberFieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          aria-invalid={error !== undefined}
          aria-describedby={error !== undefined ? errorId : undefined}
          className={`w-full rounded-md border px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 ${
            error !== undefined
              ? 'border-red-400 focus:ring-red-300'
              : 'border-slate-300 focus:ring-sky-300'
          } ${disabled ? 'bg-slate-100 text-slate-400' : 'bg-white'}`}
        />
        {suffix !== undefined && <span className="shrink-0 text-sm text-slate-500">{suffix}</span>}
      </div>
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
