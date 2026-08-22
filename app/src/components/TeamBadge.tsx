import { teamColor } from '../lib/teamColors'
import { useImageFallback } from '../lib/useImageFallback'

interface Props {
  code: number
  shortName: string
  size?: number
}

/** Team badge from the official FPL CDN, keyed by the team's `code` field
 * (distinct from the FPL `id`). Falls back to a team-coloured initial
 * (teamColors.ts) on any load failure - same reasoning as PlayerAvatar:
 * CDN hiccups, and no service-worker caching for these external images yet. */
export function TeamBadge({ code, shortName, size = 20 }: Props) {
  const [failed, markFailed] = useImageFallback()

  if (failed || !code) {
    return (
      <div
        className="rounded-full flex items-center justify-center text-white font-bold shrink-0"
        style={{ width: size, height: size, backgroundColor: teamColor(shortName), fontSize: size * 0.42 }}
      >
        {shortName.slice(0, 1)}
      </div>
    )
  }

  return (
    <img
      src={`https://resources.premierleague.com/premierleague/badges/50/t${code}.png`}
      alt={shortName}
      width={size}
      height={size}
      className="object-contain shrink-0"
      style={{ width: size, height: size }}
      onError={markFailed}
    />
  )
}
