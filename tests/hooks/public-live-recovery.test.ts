import { boundary } from '../helpers/screen-view-boundary'
import { homeHarness, homePayload } from '../helpers/home-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'
import { notifyLeagueChange, setLeagueChangesConnected } from '@/lib/league-changes'
import type { LiveSnapshot } from '@pancake/core'

const source=vi.hoisted(()=>({snapshot:null as LiveSnapshot|null,active:true}))
vi.mock('@/hooks/use-public-live-snapshot',()=>({usePublicLiveSnapshot:()=>source}))
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const h=homeHarness()
const now=Date.parse('2026-10-30T01:00:00Z')
const body=(updatedAt:number):LiveSnapshot=>({version:1,mode:'public',date:'2026-10-29',capturedAt:now,games:[{
    id:'0021',nbaId:'0021',espnId:null,status:'InProgress',updatedAt,
    home:{team:'BOS',score:2,players:[['1',2,0,0,0,0,0,0,1,1,0,0,0,1,0]]},
    away:{team:'NYK',score:0,players:[]},
}]})
beforeEach(()=>{
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval']})
    vi.setSystemTime(now)
    source.snapshot=body(now);source.active=true
    boundary.read.mockResolvedValue({...homePayload(),todaysGames:[{id:'game',nba_game_id:'0021',status:'InProgress',game_time:'2026-10-30T00:00:00Z',game_date:'2026-10-29',home_team:'BOS',away_team:'NYK'}],
        liveBasis:[{id:'matchup',homeMemberId:'member',awayMemberId:'opponent',homePoints:4,awayPoints:3,finalized:false,ready:true,
            players:[{playerId:'player',memberId:'member',nbaId:'1',espnId:null,team:'BOS',gameId:'0021',savedPoints:0,savedAt:now-300000,starter:true}]}]})
})
async function open(){await h.render();notifyLeagueChange('league',{topic:'version',version:'1',changes:[],scopes:null});setLeagueChangesConnected('league',true)}
it('uses twenty-second recovery when a fresh envelope contains a stale game',async()=>{
    source.snapshot=body(now-180000)
    await open()
    expect(h.latest.liveDelayed).toBe(true)
    await act(async()=>{await vi.advanceTimersByTimeAsync(20000)})
    expect(boundary.checks).toHaveBeenCalledOnce()
})
it('keeps ten-minute recovery for a usable live overlay',async()=>{
    await open()
    expect(h.latest.liveDelayed).toBe(false)
    await act(async()=>{await vi.advanceTimersByTimeAsync(20000)})
    expect(boundary.checks).not.toHaveBeenCalled()
})
