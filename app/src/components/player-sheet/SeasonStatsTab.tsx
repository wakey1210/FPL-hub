import type { PlayerEV } from '../../types/fpl'

interface Props {
  player: PlayerEV
}

function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function StatTile({
  label,
  actual,
  expectedLabel,
  expected,
}: {
  label: string
  actual: string
  expectedLabel?: string
  expected?: string
}) {
  return (
    <div className="bg-white/5 rounded-lg p-3">
      <p className="text-[11px] text-white/50">{label}</p>
      <p className="text-xl font-bold text-white">{actual}</p>
      {expectedLabel && (
        <p className="text-[11px] text-white/40 mt-1">
          {expectedLabel} <span className="text-primary font-semibold">{expected}</span>
        </p>
      )}
    </div>
  )
}

/** Actual-to-date season stats, each paired with the model's own forward
 * expectation for the same underlying signal - reuses the app's existing EV
 * engine as the "expected" side rather than bolting on a second,
 * disconnected historical stat. Deliberately NOT a 2025/26-vs-2026/27
 * season toggle (explicitly decided against).
 *
 * Clean sheet / goals conceded tiles are gated to GKP/DEF/MID - forwards
 * don't carry those FPL scoring rules (mirrors engine/model.py's
 * per-position scoring), so showing a permanent zero would be noise, not
 * signal. Saves is gated to GKP only for the same reason. The Starts tile's
 * defensive-contribution-bonus pairing is gated to outfield players only
 * (engine/model.py's own why-bullet logic excludes GKP from the DC bonus
 * entirely - `dc_prob` is still a real computed number for goalkeepers, it
 * just isn't a scoring category they can earn, so showing it here would be
 * misleading, not merely redundant).
 *
 * All of these fields default with `?? 0` even though the TS type marks
 * them non-optional: the frontend deploy and the data-refresh pipeline run
 * on separate schedules (deploy-pages.yml fires on every push to main,
 * data refreshes every 3h via pipeline.yml), so there's a real window where
 * newly-shipped code runs against a `players.json` snapshot generated
 * before these fields existed - crashed the whole sheet (blank screen, no
 * error boundary in this app) the first time this happened. */
export function SeasonStatsTab({ player }: Props) {
  const showCleanSheetAndConceded = player.position !== 'FWD'
  const showSaves = player.position === 'GKP'
  const showDcBonus = player.position !== 'GKP'
  const fixtureCount = player.fixtures.length
  const avgCsProb = avg(player.fixtures.map((f) => f.cs_prob))
  const avgExpectedConceded = avg(player.fixtures.map((f) => f.expected_conceded))

  return (
    <div className="grid grid-cols-2 gap-2 mb-2">
      {showCleanSheetAndConceded && (
        <StatTile
          label="Clean sheets"
          actual={String(player.clean_sheets ?? 0)}
          expectedLabel={`Forecast chance, next ${fixtureCount} GWs:`}
          expected={`${Math.round(avgCsProb * 100)}%`}
        />
      )}
      {showCleanSheetAndConceded && (
        <StatTile
          label="Goals conceded"
          actual={`${player.goals_conceded ?? 0} (${(player.expected_goals_conceded ?? 0).toFixed(1)} xGC)`}
          expectedLabel="Forecast avg/match:"
          expected={avgExpectedConceded.toFixed(2)}
        />
      )}
      {showSaves && (
        <StatTile
          label="Saves"
          actual={String(player.saves ?? 0)}
          expectedLabel="Forecast rate:"
          expected={`${(player.saves90 ?? 0).toFixed(2)}/90`}
        />
      )}
      <StatTile
        label="Starts"
        actual={String(player.starts ?? 0)}
        expectedLabel={showDcBonus ? 'Chance of DC bonus:' : undefined}
        expected={showDcBonus ? `${Math.round((player.dc_prob ?? 0) * 100)}%` : undefined}
      />
    </div>
  )
}
