import { useState } from 'react'

/** Tracks whether an image has failed to load, so a component can swap to a
 * fallback rendering (e.g. colored initials) - shared by PlayerAvatar and
 * TeamBadge so the load-failure state machine has one implementation
 * instead of two copies. Callers are responsible for remounting (e.g. via a
 * `key` on an ancestor) when the underlying image identity changes, so a
 * failure recorded for one subject doesn't leak into the next. */
export function useImageFallback(): [boolean, () => void] {
  const [failed, setFailed] = useState(false)
  return [failed, () => setFailed(true)]
}
