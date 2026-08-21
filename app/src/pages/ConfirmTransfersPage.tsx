import { useSearchParams, useNavigate } from 'react-router-dom'
import { Layout } from '../components/Layout'
import { usePlannedChanges } from '../lib/usePlannedChanges'
import { useDeclaredTeam } from '../lib/useDeclaredTeam'
import { bankAndFreeTransfersAtEvent } from '../lib/squadTimeline'
import { formatPrice } from '../lib/format'

/** Dedicated full-screen review for a gameweek's batch of manually-staged
 * transfers - replaces the small fixed-height StagedTransfersCart for Pick
 * Team's own transfer flow specifically (TransfersPage/PlannerPage keep
 * using the cart for their algorithmic suggestions, a separate flow this
 * doesn't touch). Gives the "I'm happy with this" moment that was missing -
 * there's no server round-trip to await, so Confirm and Edit both just
 * return to Pick Team; Confirm is the deliberate, named close-out action. */
export function ConfirmTransfersPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const event = Number(searchParams.get('gw'))
  const { plan, removeStagedTransfer } = usePlannedChanges()
  const { declared } = useDeclaredTeam()

  const backToPickTeam = () => navigate(`/pick-team?gw=${event}`)

  const entries = plan.stagedTransfers
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.event === event)

  const { freeTransfers: freeBefore } = bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, event - 1)
  const { bank: bankAfter } = bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, event)
  const freeUsed = Math.min(entries.length, freeBefore)
  const additionalUsed = Math.max(0, entries.length - freeBefore)
  const totalHit = entries.reduce((sum, { t }) => sum + t.hitCost, 0)

  return (
    <Layout title="Confirm Transfers" onBack={backToPickTeam} showNav={false}>
      <div className="rounded-xl bg-surface px-4 py-3 mb-4">
        <p className="text-sm font-semibold">
          You're about to make {entries.length} transfer{entries.length === 1 ? '' : 's'} for Gameweek {event}
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-white/40 text-center py-8">No transfers staged for this gameweek.</p>
      ) : (
        <div className="space-y-2 mb-4">
          {entries.map(({ t, i }) => (
            <div key={`${t.outId}-${t.inId}`} className="rounded-xl bg-surface px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <p className="text-white/50">OUT</p>
                  <p className="font-semibold">{t.outName}</p>
                </div>
                <span className="text-white/40 text-lg">→</span>
                <div className="text-sm text-right">
                  <p className="text-white/50">IN</p>
                  <p className="font-semibold">{t.inName}</p>
                </div>
              </div>
              <div className="flex items-center justify-between mt-2">
                {t.hitCost > 0 ? (
                  <p className="text-xs text-danger">-{t.hitCost} hit</p>
                ) : (
                  <span />
                )}
                <button
                  onClick={() => removeStagedTransfer(i, (ev) => bankAndFreeTransfersAtEvent(declared, plan.stagedTransfers, ev - 1).freeTransfers)}
                  className="text-xs text-white/50 underline min-h-[36px] px-2 transition-colors active:text-white"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-xl bg-surface px-4 py-3 mb-6">
        <p className="text-sm font-semibold mb-2">Points overview</p>
        <div className="flex justify-between text-sm text-white/70 py-1">
          <span>Free transfers used</span>
          <span className="text-white">{freeUsed}</span>
        </div>
        <div className="flex justify-between text-sm text-white/70 py-1">
          <span>Additional transfers used</span>
          <span className="text-white">{additionalUsed}</span>
        </div>
        {totalHit > 0 && (
          <div className="flex justify-between text-sm text-white/70 py-1">
            <span>Hit cost</span>
            <span className="text-danger">-{totalHit} pts</span>
          </div>
        )}
        <div className="flex justify-between text-sm text-white/70 py-1">
          <span>Left in the bank</span>
          <span className="text-white">{formatPrice(bankAfter)}</span>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={backToPickTeam}
          className="flex-1 min-h-[44px] rounded-xl bg-white/10 text-white text-sm font-semibold transition-colors active:bg-white/20"
        >
          Edit transfers
        </button>
        <button
          onClick={backToPickTeam}
          className="flex-1 min-h-[44px] rounded-xl bg-primary text-primary-foreground text-sm font-semibold transition-colors active:opacity-80"
        >
          Confirm
        </button>
      </div>
    </Layout>
  )
}
