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

it('rereads saved scores when stale public data has no new broadcast version',async()=>{
    source.snapshot=body(now-180000)
    await open()
    const saved=await boundary.read.mock.results[0].value
    boundary.read.mockResolvedValue({...saved,matchup:{...saved.matchup,myPoints:12},liveBasis:saved.liveBasis.map((basis:Record<string,unknown>)=>({...basis,homePoints:12}))})
    await act(async()=>{await vi.advanceTimersByTimeAsync(20250)})
    expect(boundary.read).toHaveBeenCalledTimes(2)
    expect(h.latest.matchup?.myPoints).toBe(12)
})

it('recovers today while a past day has an empty live-game list',async()=>{
    source.snapshot=null;source.active=false
    boundary.read.mockResolvedValue({...homePayload('2026-10-28'),todaysGames:[],liveGames:[],liveBasis:[],
        weekDays:[{date:'2026-10-29',isToday:true,hasGames:true}]})
    boundary.games.mockResolvedValue({data:[{id:'upcoming',status:'Scheduled',game_time:new Date(now+10000).toISOString(),game_date:'2026-10-29'}],error:null})
    await open()
    expect(boundary.games).toHaveBeenCalledOnce()
    await act(async()=>{await vi.advanceTimersByTimeAsync(10000)})
    expect(boundary.checks).toHaveBeenCalledOnce()
    await act(async()=>{await vi.advanceTimersByTimeAsync(20000)})
    expect(boundary.checks).toHaveBeenCalledTimes(2)
})

it('recovers another displayed matchup while the opened matchup stays fresh',async()=>{
    const first={id:'matchup',homeMemberId:'member',awayMemberId:'opponent',homePoints:4,awayPoints:3,finalized:false,ready:true,
        players:[{playerId:'player',memberId:'member',nbaId:'1',espnId:null,team:'BOS',gameId:'0021',savedPoints:0,savedAt:now-300000,starter:true}]}
    const other={...first,id:'other',homeMemberId:'c',awayMemberId:'d',homePoints:100,
        players:[{...first.players[0],playerId:'other-player',memberId:'c',team:'LAL',gameId:'0022'}]}
    const saved={...homePayload(),context:{...homePayload().context,league:{scoring_settings:{points:1}}},liveBasis:[first,other],
        leagueMatchups:[{id:'other',homePoints:100,awayPoints:3}],
        liveGames:[{nba_game_id:'0021',status:'InProgress',game_date:'2026-10-29'},{nba_game_id:'0022',status:'InProgress',game_date:'2026-10-29'}]}
    boundary.read.mockResolvedValue(saved)
    await open()
    expect(h.latest.matchup?.myPoints).toBe(6)
    expect(h.latest.liveDelayed).toBe(true)
    boundary.read.mockResolvedValue({...saved,liveBasis:[first,{...other,homePoints:106}],leagueMatchups:[{id:'other',homePoints:106,awayPoints:3}]})
    await act(async()=>{await vi.advanceTimersByTimeAsync(20250)})
    expect(boundary.checks).toHaveBeenCalledOnce()
    expect(boundary.read).toHaveBeenCalledTimes(2)
    expect(h.latest.leagueMatchups[0].homePoints).toBe(106)
})
