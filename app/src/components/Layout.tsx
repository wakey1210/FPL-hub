import type { ReactNode } from 'react'
import { BottomNav } from './BottomNav'

export function Layout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#111117] text-white">
      <header className="sticky top-0 z-10 bg-[#37003c] px-4 pt-[env(safe-area-inset-top)] pb-3">
        <h1 className="text-lg font-bold pt-2">{title}</h1>
      </header>
      <main className="px-4 py-4 pb-24 max-w-2xl mx-auto">{children}</main>
      <BottomNav />
    </div>
  )
}

export function LoadingState() {
  return <p className="text-center text-white/50 py-12 text-sm">Loading…</p>
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="text-center text-rose-300 py-12 text-sm">
      <p>Couldn't load data.</p>
      <p className="text-white/40 mt-1">{message}</p>
    </div>
  )
}
