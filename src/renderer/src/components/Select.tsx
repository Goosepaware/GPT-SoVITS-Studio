import { Children, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
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
  ariaLabel?: string
  menuWidth?: number
  align?: 'left' | 'right'
  placement?: 'top' | 'bottom'
}

interface MenuPosition {
  left: number
  top: number
  width: number
  maxHeight: number
  placement: 'top' | 'bottom'
}

export function Select({
  value,
  onChange,
  children,
  className,
  compact = false,
  disabled = false,
  placeholder = '请选择',
  ariaLabel,
  menuWidth,
  align = 'left',
  placement
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuId = useId()
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
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selected = options[selectedIndex] || options[0]

  const updatePosition = useCallback((): void => {
    const element = trigger.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const width = Math.max(rect.width, menuWidth || 0)
    const gap = 5
    const margin = 8
    const desiredHeight = Math.min(238, Math.max(96, options.length * 34 + 8))
    const below = window.innerHeight - rect.bottom - gap - margin
    const above = rect.top - gap - margin
    const actualPlacement = placement || (below < desiredHeight && above > below ? 'top' : 'bottom')
    const maxHeight = Math.max(80, Math.min(desiredHeight, actualPlacement === 'top' ? above : below))
    const rawLeft = align === 'right' ? rect.right - width : rect.left
    const maxLeft = Math.max(margin, window.innerWidth - width - margin)
    setPosition({
      left: Math.min(Math.max(margin, rawLeft), maxLeft),
      top: actualPlacement === 'top' ? Math.max(margin, rect.top - gap - maxHeight) : rect.bottom + gap,
      width,
      maxHeight,
      placement: actualPlacement
    })
  }, [align, menuWidth, options.length, placement])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (root.current && !root.current.contains(target) && menu.current && !menu.current.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (open && position) optionRefs.current[activeIndex]?.focus({ preventScroll: true })
  }, [activeIndex, open, position])

  function openMenu(index = selectedIndex): void {
    if (disabled) return
    setActiveIndex(index)
    setOpen(true)
  }

  function choose(index: number): void {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
    trigger.current?.focus()
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openMenu(0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(Math.max(0, options.length - 1))
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!options.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % options.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + options.length) % options.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(options.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(activeIndex)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
  }

  return (
    <div ref={root} className={cn('custom-select', compact && 'compact', open && 'open', disabled && 'disabled', className)}>
      <button
        ref={trigger}
        type="button"
        className="custom-select-trigger"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <span className="custom-select-value">{selected?.label ?? placeholder}</span>
        <ChevronDown size={14} className="custom-select-caret" />
      </button>
      {open && position && createPortal(
        <motion.div
          key="select-menu"
          ref={menu}
          id={menuId}
          className="custom-select-menu"
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={`${menuId}-${activeIndex}`}
          onKeyDown={onMenuKeyDown}
          initial={{ opacity: 0, y: position.placement === 'top' ? 4 : -4, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.14 }}
          style={{
            position: 'fixed',
            left: position.left,
            top: position.top,
            right: 'auto',
            width: position.width,
            maxHeight: position.maxHeight,
            zIndex: 1000,
            transformOrigin: position.placement === 'top' ? 'bottom center' : 'top center'
          }}
        >
          {options.map((option, index) => (
            <button
              ref={(element) => { optionRefs.current[index] = element }}
              key={option.value}
              id={`${menuId}-${index}`}
              type="button"
              className={cn('custom-select-option', option.value === value && 'selected')}
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              tabIndex={-1}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={13} />}
            </button>
          ))}
        </motion.div>,
        document.body
      )}
    </div>
  )
}
