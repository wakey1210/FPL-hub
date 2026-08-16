import { useEffect, useState } from 'react'

export function useLocalStorage(key: string, initial = ''): [string, (v: string) => void] {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? initial)

  useEffect(() => {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  }, [key, value])

  return [value, setValue]
}
