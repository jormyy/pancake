import { createContext, useContext } from 'react'

export const PanelActivityContext = createContext(true)

export function usePanelActivity(): boolean {
    return useContext(PanelActivityContext)
}
