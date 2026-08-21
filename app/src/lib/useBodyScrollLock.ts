import { useEffect } from 'react'

/** Locks background scroll while `active` is true - plain CSS
 * `overflow: hidden` on body doesn't stop touch-scroll on iOS Safari, so
 * this uses the position-fixed body-lock technique instead (pin body in
 * place at its current scroll offset, restore and re-scroll to it on
 * cleanup). Used by every bottom sheet/modal so the page behind it can't
 * scroll while it's open. */
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    const scrollY = window.scrollY
    const { position, top, width } = document.body.style
    document.body.style.position = 'fixed'
    document.body.style.top = `-${scrollY}px`
    document.body.style.width = '100%'
    return () => {
      document.body.style.position = position
      document.body.style.top = top
      document.body.style.width = width
      window.scrollTo(0, scrollY)
    }
  }, [active])
}
