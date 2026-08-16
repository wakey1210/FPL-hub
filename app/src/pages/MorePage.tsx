import { useJsonData } from '../lib/data'
import { useLocalStorage } from '../lib/useLocalStorage'
import { Layout } from '../components/Layout'
import type { Meta } from '../types/fpl'

export function MorePage() {
  const meta = useJsonData<Meta>('meta.json')
  const [teamId, setTeamId] = useLocalStorage('fpl_team_id')

  return (
    <Layout title="More">
      <div className="space-y-4">
        <div className="rounded-2xl bg-[#1e1e2a] p-5">
          <h2 className="text-sm font-semibold mb-2">Your FPL team ID</h2>
          <p className="text-xs text-white/50 mb-3">
            Your public FPL team ID (find it in the URL when viewing "Points" on the official site,
            e.g. fantasy.premierleague.com/entry/<b>1234567</b>/event/1). No password needed - transfers,
            chips, bank and picks are all public with just this ID.
          </p>
          <input
            value={teamId}
            onChange={(e) => setTeamId(e.target.value.replace(/\D/g, ''))}
            placeholder="e.g. 1234567"
            inputMode="numeric"
            className="w-full rounded-xl bg-[#2a2a38] px-3 py-2 text-sm outline-none placeholder:text-white/30"
          />
          {teamId && (
            <a
              className="inline-block mt-2 text-xs text-[#00ff87] underline"
              href={`https://fantasy.premierleague.com/entry/${teamId}/history`}
              target="_blank"
              rel="noreferrer"
            >
              View your team on the official site ↗
            </a>
          )}
          <p className="text-[11px] text-amber-300/80 mt-3">
            Live team tracking (transfers made, chips used, rank history) is on the roadmap - v1 focuses
            on the initial squad and transfer suggestions.
          </p>
        </div>

        <div className="rounded-2xl bg-[#1e1e2a] p-5 text-sm text-white/70">
          <h2 className="text-sm font-semibold text-white mb-2">Model &amp; data</h2>
          <ul className="space-y-1 text-xs">
            <li>Model version: {meta.data?.model_version ?? '…'}</li>
            <li>Data last refreshed: {meta.data ? new Date(meta.data.generated_at).toLocaleString() : '…'}</li>
            <li>Source: official FPL API (public endpoints only)</li>
          </ul>
          <p className="text-xs mt-3">
            Prediction accuracy will be tracked here gameweek-by-gameweek once the season starts, so the
            model's real error rate stays visible rather than a black box.
          </p>
        </div>

        <div className="rounded-2xl bg-[#1e1e2a] p-5 text-xs text-white/40">
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
