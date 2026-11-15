import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/format'

interface OptionInfo {
  value: string
  label: ReactNode
  disabled: boolean
}

interface Props {
  value: string
  onChange: (value: string) => void
  children: ReactNode
  className?: string
  compact?: boolean
  disabled?: boolean
  placeholder?: string
}

export function Select({ value, onChange, children, className, compact = false, disabled = false, placeholder = '请选择' }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const options: OptionInfo[] = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const props = child.props as { value?: string | number; children?: ReactNode; disabled?: boolean }
      return {
        value: String(props.value ?? ''),
        label: props.children,
        disabled: Boolean(props.disabled)
      }
    })
  const selected = options.find((option) => option.value === value) || options[0]

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={root} className={cn('custom-select', compact && 'compact', open && 'open', disabled && 'disabled', className)}>
      <button
        type="button"
        className="custom-select-trigger"
        onClick={() => !disabled && setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="custom-select-value">{selected?.label ?? placeholder}</span>
        <ChevronDown size={14} className="custom-select-caret" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="custom-select-menu"
            role="listbox"
            initial={{ opacity: 0, y: -4, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.985 }}
            transition={{ duration: 0.14 }}
          >
            {options.map((option) => (
              <button
                type="button"
                key={option.value}
                className={cn('custom-select-option', option.value === value && 'selected')}
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span>{option.label}</span>
                {option.value === value && <Check size={13} />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
