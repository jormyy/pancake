import React from 'react'
import { createRoot } from 'react-dom/client'
import { TeamTimelineScreen } from '@/components/timeline/TeamTimelineScreen'

createRoot(document.getElementById('root')!).render(<TeamTimelineScreen leagueId="league" memberId="team" teamName="Maple City" />)
