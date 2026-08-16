import { useState } from 'react'

interface Props {
  squadSize: number
  defaultBank: number // tenths of £m
  onConfirm: (bank: number, freeTransfers: number) => void
  onClose: () => void
}

const FREE_TRANSFER_OPTIONS = [0, 1, 2, 3, 4, 5]

/** Lets Transfers/the Planner start suggesting moves immediately, without
 * waiting for a live FPL team ID to sync real post-deadline picks - saves
 * the currently-shown squad plus a manually-entered bank/free-transfers
 * count locally (see useDeclaredTeam). Never writes anything back to FPL. */
export function ConfirmSquadModal({ squadSize, defaultBank, onConfirm, onClose }: Props) {
  const [bankInput, setBankInput] = useState((defaultBank / 10).toFixed(1))
  const [freeTransfers, setFreeTransfers] = useState(1)

  const handleConfirm = () => {
    const bankTenths = Math.round((parseFloat(bankInput || '0') || 0) * 10)
    onConfirm(bankTenths, freeTransfers)
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end bg-black/50" onClick={onClose}>
      <div
        className="w-full bg-[#1e1e2a] rounded-t-2xl p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-white mb-1">Confirm my squad</h2>
        <p className="text-sm text-white/60 mb-5">
          Saves this 15 locally so Transfers and the Planner can start suggesting moves right
          away - this never writes anything back to the official FPL app.
        </p>

        <label className="block text-xs font-semibold text-white/70 mb-1">Bank (£m remaining)</label>
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          min="0"
          value={bankInput}
          onChange={(e) => setBankInput(e.target.value)}
          className="w-full rounded-xl bg-white/10 px-3 py-2.5 text-sm mb-4 outline-none"
        />

        <label className="block text-xs font-semibold text-white/70 mb-1">Free transfers</label>
        <div className="flex gap-1.5 mb-6">
          {FREE_TRANSFER_OPTIONS.map((n) => (
            <button
              key={n}
              onClick={() => setFreeTransfers(n)}
              className={`min-h-[40px] flex-1 rounded-lg text-sm font-semibold transition-colors ${
                freeTransfers === n ? 'bg-[#00ff87] text-black' : 'bg-white/10 text-white/60'
              }`}
            >
              {n}
            </button>
          ))}
        </div>

        <button
          onClick={handleConfirm}
          className="w-full min-h-[44px] rounded-xl bg-[#00ff87] text-black text-sm font-semibold transition-colors active:opacity-80"
        >
          Confirm squad ({squadSize} players)
        </button>
        <button
          onClick={onClose}
          className="w-full mt-2 min-h-[40px] rounded-xl bg-white/10 text-white/70 text-xs font-semibold transition-colors active:bg-white/20"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
