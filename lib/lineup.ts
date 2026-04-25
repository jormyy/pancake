export { canPlaySlot, SLOT_ELIGIBLE } from '@/constants/slots'
export type { LineupPlayer, LineupSlot, LineupContext, WeekDay } from './lineup/read'
export {
    getStartedTeams,
    getTeamMatchups,
    getLiveTeams,
    getLineupContext,
    getWeekDays,
    getWeeklyLineup,
    setPlayerSlot,
} from './lineup/read'
export { autoSetLineup } from './lineup/autoSet'
