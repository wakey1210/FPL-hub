import { teamColor } from '../lib/teamColors'
import { useImageFallback } from '../lib/useImageFallback'

interface Props {
  code: number
  teamShort: string
  size?: number
}

/** Circular player photo from the official FPL CDN, keyed by the player's
 * `code` field (NOT `id` - `code` is FPL's stable, cross-season photo key;
 * `id` is per-season and would silently 404 for returning players).
 * Falls back to a team-coloured initials circle (teamColors.ts) on any load
 * failure - covers CDN hiccups, delayed photo uploads for brand-new
 * transfers, and offline PWA use (these external images aren't
 * service-worker-cached today, see vite.config.ts). */
export function PlayerAvatar({ code, teamShort, size = 40 }: Props) {
  const [failed, markFailed] = useImageFallback()

  if (failed || !code) {
    return (
      <div
        className="rounded-full flex items-center justify-center text-white font-bold shrink-0"
        style={{ width: size, height: size, backgroundColor: teamColor(teamShort), fontSize: size * 0.32 }}
      >
        {teamShort.slice(0, 2)}
      </div>
    )
  }

  return (
    <img
      src={`https://resources.premierleague.com/premierleague/photos/players/110x140/p${code}.png`}
      alt=""
      width={size}
      height={size}
      className="rounded-full object-cover bg-white/10 shrink-0"
      style={{ width: size, height: size }}
      onError={markFailed}
    />
  )
}
