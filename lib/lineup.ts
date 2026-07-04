export { canPlaySlot, SLOT_ELIGIBLE } from '@/constants/slots'
export type { LineupPlayer, LineupSlot, LineupContext, WeekDay } from './lineup/read'
export {
    clampDateToWeek,
    getStartedTeams,
    getTeamMatchups,
    getLineupContext,
    getWeekDays,
    getWeeklyLineup,
    setPlayerSlot,
    setPlayerSlotMoves,
} from './lineup/read'
export { autoSetLineup } from './lineup/autoSet'
