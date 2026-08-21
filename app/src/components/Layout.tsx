import type { ReactNode } from 'react'
import { BottomNav } from './BottomNav'

interface Props {
  title: string
  children: ReactNode
  /** Renders a back arrow before the title instead of the bottom tab bar -
   * for focused full-screen flows (Add Player, Confirm Transfers) that
   * shouldn't feel like just another tab. */
  onBack?: () => void
  showNav?: boolean
}

export function Layout({ title, children, onBack, showNav = true }: Props) {
  return (
    <div className="min-h-screen bg-background text-white">
      <header className="sticky top-0 z-10 bg-header px-4 pt-[env(safe-area-inset-top)] pb-3">
        <div className="flex items-center gap-2 pt-2">
          {onBack && (
            <button
              onClick={onBack}
              aria-label="Back"
              className="text-white text-xl leading-none min-w-[36px] min-h-[36px] -ml-1.5 rounded-full transition-colors active:bg-white/10"
            >
              ‹
            </button>
          )}
          <h1 className="text-lg font-bold">{title}</h1>
        </div>
      </header>
      <main className={`px-4 py-4 max-w-2xl mx-auto ${showNav ? 'pb-24' : 'pb-6'}`}>{children}</main>
      {showNav && <BottomNav />}
    </div>
  )
}

export function LoadingState() {
  return <p className="text-center text-white/50 py-12 text-sm">Loading…</p>
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="text-center text-danger py-12 text-sm">
      <p>Couldn't load data.</p>
      <p className="text-white/40 mt-1">{message}</p>
    </div>
  )
}
