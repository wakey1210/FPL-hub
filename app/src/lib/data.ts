import { useEffect, useState } from 'react'

// Engine output lives at /data/*.json, committed by the GitHub Actions pipeline
// and served same-origin alongside the built app (no CORS issues, no backend).
const DATA_BASE = `${import.meta.env.BASE_URL}data`

interface FetchState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export function useJsonData<T>(file: string): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ data: null, loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    fetch(`${DATA_BASE}/${file}?t=${Date.now()}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${file}: ${res.status}`)
        return res.json()
      })
      .then((json) => {
        if (!cancelled) setState({ data: json as T, loading: false, error: null })
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ data: null, loading: false, error: err.message })
      })
    return () => {
      cancelled = true
    }
  }, [file])

  return state
}
