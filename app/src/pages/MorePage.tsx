import { useJsonData } from '../lib/data'
import { useLocalStorage } from '../lib/useLocalStorage'
import { Layout } from '../components/Layout'
import { AccuracySummary } from '../components/AccuracySummary'
import type { Meta } from '../types/fpl'
import type { MyTeam } from '../types/myTeam'
import type { AccuracySummary as AccuracySummaryData } from '../types/accuracy'

export function MorePage() {
  const meta = useJsonData<Meta>('meta.json')
  const myTeam = useJsonData<MyTeam>('my_team.json')
  const accuracy = useJsonData<AccuracySummaryData>('accuracy_summary.json')
  const [teamId, setTeamId] = useLocalStorage('fpl_team_id')

  return (
    <Layout title="More">
      <div className="space-y-4">
        <div className="rounded-2xl bg-surface p-5">
          <h2 className="text-sm font-semibold mb-2">Your FPL team</h2>
          {myTeam.data?.configured ? (
            <p className="text-sm text-white/70">
              Live tracking is set up for <span className="text-white font-medium">{myTeam.data.team_name}</span>{' '}
              (ID {myTeam.data.team_id}) - transfers, chips, bank and picks refresh automatically every 3 hours.
            </p>
          ) : (
            <p className="text-xs text-white/50">
              Live tracking isn't configured yet. It's set up once, as a repository variable in
              GitHub Actions (not from this app), since the FPL API can only be called from the
              server side.
            </p>
          )}

          <label className="block text-xs text-white/50 mt-4 mb-1">
            Bookmark a team ID for the official site link:
          </label>
          <input
            value={teamId}
            onChange={(e) => setTeamId(e.target.value.replace(/\D/g, ''))}
            placeholder="e.g. 1234567"
            inputMode="numeric"
            className="w-full rounded-xl bg-surface-raised px-3 py-2 text-sm outline-none placeholder:text-white/30"
          />
          {teamId && (
            <a
              className="inline-block mt-2 text-xs text-primary underline"
              href={`https://fantasy.premierleague.com/entry/${teamId}/history`}
              target="_blank"
              rel="noreferrer"
            >
              View on the official site ↗
            </a>
          )}
        </div>

        <div className="rounded-2xl bg-surface p-5 text-sm text-white/70">
          <h2 className="text-sm font-semibold text-white mb-2">Prediction accuracy</h2>
          {accuracy.data ? <AccuracySummary data={accuracy.data} /> : <p className="text-xs">…</p>}
        </div>

        <div className="rounded-2xl bg-surface p-5 text-sm text-white/70">
          <h2 className="text-sm font-semibold text-white mb-2">Model &amp; data</h2>
          <ul className="space-y-1 text-xs">
            <li>Model version: {meta.data?.model_version ?? '…'}</li>
            <li>Data last refreshed: {meta.data ? new Date(meta.data.generated_at).toLocaleString() : '…'}</li>
            <li>Source: official FPL API (public endpoints only)</li>
            {meta.data?.ml_model_loaded && (
              <li>
                Experimental ML model (XGBoost, retrained weekly):{' '}
                {meta.data.ml_eligible
                  ? 'currently outperforming the heuristic - see Prediction accuracy above'
                  : 'tracked for comparison, not yet beating the heuristic consistently enough to be trusted'}
              </li>
            )}
          </ul>
        </div>

        <div className="rounded-2xl bg-surface p-5 text-xs text-white/40">
          <a
            href="https://github.com/wakey1210/FPL-hub"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Source on GitHub ↗
          </a>
        </div>
      </div>
    </Layout>
  )
}
