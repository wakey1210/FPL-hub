import type { ReactNode } from 'react'
import { useBodyScrollLock } from '../lib/useBodyScrollLock'

interface Props {
  onClose: () => void
  children: ReactNode
  zIndex?: number
}

/** Shared backdrop + slide-up sheet + body-scroll-lock, consolidating the
 * `fixed inset-0 flex items-end` overlay pattern `PlayerDetailSheet` and
 * `ConfirmSquadModal` each used to duplicate - locks the page behind it so
 * it can't scroll while the sheet is open (see useBodyScrollLock). */
export function BottomSheet({ onClose, children, zIndex = 30 }: Props) {
  useBodyScrollLock(true)

  return (
    <div
      className="fixed inset-0 flex items-end bg-black/50"
      style={{ zIndex }}
      onClick={onClose}
    >
      <div
        className="w-full bg-surface rounded-t-2xl p-5 pb-8 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
