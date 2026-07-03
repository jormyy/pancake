import { describe, expect, it } from 'vitest'
import { latestFunctionDefinition, read } from './source-guard'

const goalMigration = read('supabase/migrations/20260701000001_mock_draft_rooms_lineup_optimizer.sql')
const leagueScreen = read('app/(tabs)/league.tsx')
const leagueDraftPanels = read('components/league/LeagueDraftPanels.tsx')
const leagueTabs = read('lib/league/tabs.ts')
const draftLib = read('lib/draft.ts')
const mockRoomsLib = read('lib/mockDraftRooms.ts')
const lineupOptimizer = read('supabase/functions/lineup-optimizer/index.ts')
const draftApi = read('supabase/functions/api/draft.ts')

describe('fantasy draft and auction experience goals', () => {
    it('shows auction player age from dynasty ranking data', () => {
        expect(draftLib).toContain('age: number | null')
        expect(draftLib).toContain('getLatestDynastyAges')
        expect(draftLib).toContain(".from('dynasty_rankings')")
        expect(read('app/(modals)/draft-room.tsx')).toContain('ageLabel')
    })

    it('models joinable scheduled mock draft rooms scoped to joined members', () => {
        expect(goalMigration).toContain('CREATE TABLE IF NOT EXISTS public.draft_room_members')
        expect(goalMigration).toContain('created_by_member_id')
        expect(goalMigration).toContain('scheduled_at')
        expect(latestFunctionDefinition('create_mock_draft_room_atomic')).toContain('INSERT INTO public.drafts')
        expect(latestFunctionDefinition('create_mock_draft_room_atomic')).toContain("'pending'")
        expect(latestFunctionDefinition('join_mock_draft_room_atomic')).toContain("v_draft.status <> 'pending'")
        expect(latestFunctionDefinition('start_mock_draft_room_atomic')).toContain('FROM public.draft_room_members')
        expect(latestFunctionDefinition('start_mock_draft_room_atomic')).toContain('Need at least 2 joined managers')
        expect(draftApi).toContain('Mock drafts must be created and started from a mock draft room')
        expect(mockRoomsLib).toContain("roomStatus: MockDraftRoomStatus")
        expect(mockRoomsLib).toContain("'scheduled'")
        expect(mockRoomsLib).toContain("'live'")
        expect(mockRoomsLib).toContain("'completed'")
    })

    it('keeps draft navigation focused by tab purpose', () => {
        for (const label of ['Results', 'Auctions', 'Mock Rooms', 'Draft Board', 'Settings', 'History']) {
            expect(leagueTabs).toContain(label)
        }
        expect(leagueScreen).toContain('<MockRoomsPanel')
        expect(leagueScreen).toContain('<AuctionPanel')
        expect(leagueScreen).toContain('<DraftBoardPanel')
        expect(leagueDraftPanels).toContain('function ActiveDraftEntry')
        expect(leagueDraftPanels).toContain('filterType="snake"')
        expect(leagueDraftPanels).not.toContain('Start Mock Auction')
        expect(leagueDraftPanels).not.toContain('Start Mock Rookie Draft')
    })

    it('adds a persistent season-long lineup optimizer processor', () => {
        expect(goalMigration).toContain('CREATE TABLE IF NOT EXISTS public.lineup_optimizer_settings')
        expect(goalMigration).toContain("'nba-lineup-optimizer'")
        expect(goalMigration).toContain("public.invoke_edge_function('lineup-optimizer')")
        expect(lineupOptimizer).toContain("from('lineup_optimizer_settings')")
        expect(lineupOptimizer).toContain('auto_set_lineup_atomic')
        expect(lineupOptimizer).toContain('compareScore')
        expect(lineupOptimizer).toContain('healthy')
        expect(read('components/AutoSetModal.tsx')).toContain('Enable Season Optimizer')
        expect(read('app/(modals)/lineup.tsx')).toContain('setLineupOptimizerEnabled')
    })
})
