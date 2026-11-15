import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import type { Notice } from '@shared/types'

interface Props {
  notices: Notice[]
  onDismiss: (id: string) => void
}

export function ToastStack({ notices, onDismiss }: Props): JSX.Element {
  return (
    <div className="toast-stack">
      <AnimatePresence initial={false}>
        {notices.map((notice) => {
          const Icon = notice.tone === 'error' ? AlertTriangle : notice.tone === 'success' ? CheckCircle2 : Info
          return (
            <motion.div
              key={notice.id}
              className={`toast ${notice.tone}`}
              initial={{ opacity: 0, y: 18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <Icon size={17} />
              <span>{notice.message}</span>
              <button onClick={() => onDismiss(notice.id)}>
                <X size={14} />
              </button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
