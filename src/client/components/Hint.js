import { createContext, useContext, useMemo, useState } from 'react'

export const HintContext = createContext()

export function HintProvider({ children }) {
  const [hint, setHint] = useState(null)
  const api = useMemo(() => {
    return { hint, setHint }
  }, [hint])
  return <HintContext.Provider value={api}>{children}</HintContext.Provider>
}

export function useHintProps(hint) {
  const { setHint } = useContext(HintContext)
  return {
    onPointerEnter: () => setHint(hint),
    onPointerLeave: () => setHint(null),
  }
}
