import { useJsonData } from '../lib/data'
import { Layout, LoadingState, ErrorState } from '../components/Layout'
import { fdrClasses } from '../lib/format'
import type { TeamTicker } from '../types/ticker'

export function PlannerPage() {
  const ticker = useJsonData<TeamTicker[]>('fixtures.json')

  if (ticker.loading) return <Layout title="Planner"><LoadingState /></Layout>
  if (ticker.error || !ticker.data) return <Layout title="Planner"><ErrorState message={ticker.error ?? 'no data'} /></Layout>

  const gwCount = Math.max(...ticker.data.map((t) => t.fixtures.length), 0)
  const gwLabels = Array.from({ length: gwCount }, (_, i) => i + 1)

  return (
    <Layout title="Planner">
      <p className="text-xs text-white/50 mb-3">
        Fixture difficulty ticker, easiest run first. Use this to time transfers, wildcards and chips -
        the Ben Crellin sheet replacement.
      </p>
      <div className="overflow-x-auto -mx-4 px-4">
        <table className="w-full text-sm border-separate border-spacing-y-1.5 min-w-[420px]">
          <thead>
            <tr className="text-[11px] text-white/40">
              <th className="text-left font-medium pr-2">Team</th>
              {gwLabels.map((gw) => (
                <th key={gw} className="font-medium px-0.5">GW{gw}</th>
              ))}
              <th className="font-medium pl-2">Avg</th>
            </tr>
          </thead>
          <tbody>
            {ticker.data.map((team) => (
              <tr key={team.team_short} className="bg-[#1e1e2a]">
                <td className="rounded-l-lg pl-2 py-1.5 font-semibold text-xs whitespace-nowrap">
                  {team.team_short}
                </td>
                {gwLabels.map((gw) => {
                  const fx = team.fixtures.find((f) => f.event === gw)
                  return (
                    <td key={gw} className="px-0.5 py-1.5 text-center">
                      {fx ? (
                        <span
                          className={`inline-block w-full min-w-[38px] rounded text-[10px] font-bold py-1 ${fdrClasses(fx.fdr)}`}
                        >
                          {fx.is_home ? fx.opponent_short : fx.opponent_short.toLowerCase()}
                        </span>
                      ) : (
                        <span className="text-white/20 text-[10px]">-</span>
                      )}
                    </td>
                  )
                })}
                <td className="rounded-r-lg pr-2 pl-2 text-xs font-semibold text-white/70 text-right">
                  {team.avg_fdr?.toFixed(1) ?? '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-white/30 mt-3">Uppercase = home fixture, lowercase = away.</p>
    </Layout>
  )
}
