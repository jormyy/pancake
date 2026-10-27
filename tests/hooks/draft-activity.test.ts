import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
import { useRookieDraftRoomController } from '@/hooks/useRookieDraftRoomController'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))

const mocks = vi.hoisted(() => ({
    appState: 'active', focused: true, listeners: new Set<(next: string) => void>(),
    auction: vi.fn(), rookie: vi.fn(), pool: vi.fn(async (..._args: unknown[]) => []), search: vi.fn(async (..._args: unknown[]) => []),
    revision: vi.fn(async () => 'revision'), launch: vi.fn(async () => ({id:'draft',draftType:'auction'})), push: vi.fn(),
    bid: vi.fn(), nominate: vi.fn(), pick: vi.fn(), expire: vi.fn(async () => ({closed:0,processed:false})),
    auctionChange: null as null | (() => void), rookieChange: null as null | (() => void),
    auctionStatus: null as null | ((status:string) => void),
    auctionResume: null as null | (() => Promise<boolean>), rookieResume: null as null | (() => Promise<boolean>),
}))
vi.mock('@/lib/cache/screen-cache', () => ({ readScreenView: async (scope: { params: { draftId: string; query?: string } }, options?: { checkVersion: boolean }) => scope.params.draftId === 'draft'
    ? scope.params.query ? { searchResults: await mocks.search(scope.params.query) } : await mocks.auction()
    : options?.checkVersion === false ? { prospects: await mocks.pool(scope.params.draftId, scope.params.query) } : await mocks.rookie(),
}))
vi.mock('@/lib/league-version', () => ({ subscribeLeagueVersion: () => () => {} }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => mocks.focused }))
vi.mock('expo-router', () => ({ useRouter: () => ({push:mocks.push}) }))
vi.mock('react-native', () => ({ AppState: { get currentState(){return mocks.appState},
    addEventListener: (_name:string, listener:(next:string)=>void) => {mocks.listeners.add(listener);return {remove:()=>mocks.listeners.delete(listener)}} } }))
vi.mock('@/lib/draft', () => ({getDraftState:mocks.auction,getDraftPollRevision:mocks.revision,searchPlayers:mocks.search,
    acquireJoinableDraft: () => ({promise:mocks.launch(),release:vi.fn()}),placeBid:mocks.bid,nominatePlayer:mocks.nominate,withdrawNomination:vi.fn(),closeExpiredNominations:mocks.expire,
    subscribeToDraft: (_id:unknown,_league:unknown,change:()=>void,status:(status:string)=>void,resume:()=>Promise<boolean>) => {
        mocks.auctionChange=change;mocks.auctionStatus=status;mocks.auctionResume=resume;return {}
    },unsubscribeFromDraft:vi.fn(),
}))
vi.mock('@/lib/rookieDraft', () => ({getRookieDraftState:mocks.rookie,getRookiePlayers:mocks.pool,getRookieDraftPollRevision:mocks.revision,
    makeSnakePick:mocks.pick,commissionerSnakePick:vi.fn(),processExpiredSnakePick:mocks.expire,activateRookieDraftLeague:vi.fn(),
    subscribeToRookieDraft: (_id:unknown,change:()=>void,resume:()=>Promise<boolean>) => {mocks.rookieChange=change;mocks.rookieResume=resume;return {}},unsubscribeFromRookieDraft:vi.fn(),
}))
vi.mock('@/lib/roster', () => ({getRoster:vi.fn(async()=>[]),dropPlayer:vi.fn()}))
vi.mock('@/lib/alert', () => ({showAlert:vi.fn()}))
vi.mock('@/contexts/league-context', () => ({useLeagueContext:()=>({current:null,currentLeague:{id:'league'}})}))
vi.mock('@/lib/realtime', () => ({reportRealtimeCleanup:vi.fn()}))
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let auction!:ReturnType<typeof useAuctionDraftRoomController>
let rookie!:ReturnType<typeof useRookieDraftRoomController>
let launcher!:ReturnType<typeof useDraftRoomLauncher>
let renderer:ReactTestRenderer|undefined
let page:EventTarget
let network:EventTarget
let visible:boolean
let online:boolean
const Probe=({member='member'}:{member?:string})=>{
    auction=useAuctionDraftRoomController({draftId:'draft',memberId:member})
    rookie=useRookieDraftRoomController({draftId:'rookie',memberId:member,leagueId:'league',rosterSize:20})
    launcher=useDraftRoomLauncher('league',{scopeKey:member})
    return null
}
const advance=async(ms:number)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms)})}
const event=async(kind:'hidden'|'visible'|'offline'|'online'|'background'|'active')=>{
    await act(async()=>{
        if(kind==='hidden'||kind==='visible'){visible=kind==='visible';page.dispatchEvent(new Event('visibilitychange'))}
        else if(kind==='offline'||kind==='online'){online=kind==='online';network.dispatchEvent(new Event(kind))}
        else{mocks.appState=kind;for(const listener of mocks.listeners)listener(kind)}
    })
}
const mount=async()=>{await act(async()=>{renderer=create(React.createElement(Probe))})}
const readCounts=()=>[mocks.auction.mock.calls.length,mocks.rookie.mock.calls.length,mocks.pool.mock.calls.length,mocks.search.mock.calls.length,mocks.revision.mock.calls.length,mocks.launch.mock.calls.length]
beforeEach(()=>{
    setSessionOwner('user-a')
    vi.useFakeTimers();vi.clearAllMocks();mocks.listeners.clear();mocks.focused=true;mocks.appState='active';visible=true;online=true
    page=new EventTarget();network=new EventTarget()
    Object.defineProperty(page,'visibilityState',{get:()=>visible?'visible':'hidden'})
    vi.stubGlobal('document',page);vi.stubGlobal('window',network);vi.stubGlobal('navigator',{get onLine(){return online}})
    mocks.auction.mockResolvedValue({draft:{id:'draft',status:'in_progress',nominationOrderMode:'user_nominated'},budgets:[],nominations:[],activeBids:[],order:[],openNomination:null})
    mocks.rookie.mockResolvedValue({draft:{id:'rookie',status:'in_progress',leagueId:'league',leagueSeasonId:'season',isCurrentSeason:true},picks:[],nextPick:null,orders:[]})
})
afterEach(()=>{act(()=>renderer?.unmount());renderer=undefined;vi.useRealTimers();vi.unstubAllGlobals()})
describe('draft activity admission',()=>{
    it.each(['hidden','offline','background'] as const)('defers initial reads, retries, searches and callbacks while %s',async blocked=>{
        if(blocked==='hidden')visible=false
        else if(blocked==='offline')online=false
        else mocks.appState='background'
        await mount()
        await act(async()=>{
            void auction.refresh();void rookie.refresh();void launcher.openDraftRoom()
            auction.setNominating(true);auction.setSearchQuery('latest');rookie.setQuery('latest')
            mocks.auctionChange?.();mocks.rookieChange?.();void mocks.auctionResume?.();void mocks.rookieResume?.()
        })
        await advance(60000)
        expect(readCounts()).toEqual([0,0,0,0,0,0])
        await event(blocked==='hidden'?'visible':blocked==='offline'?'online':'active')
        await advance(300)
        expect(mocks.auction).toHaveBeenCalledTimes(1)
        expect(mocks.rookie).toHaveBeenCalledTimes(1)
        expect(mocks.pool).toHaveBeenCalledTimes(1)
        expect(mocks.pool).toHaveBeenLastCalledWith('rookie','latest')
        expect(mocks.launch).toHaveBeenCalledTimes(1)
    })
    it('keeps actions off and drops old responses until one current catch-up finishes',async()=>{
        await mount();await act(async()=>{mocks.auctionStatus?.('SUBSCRIBED')})
        await event('offline');const before=readCounts()
        await act(async()=>{mocks.auctionChange?.();mocks.rookieChange?.();auction.setNominating(true);auction.setSearchQuery('next');rookie.setQuery('next')})
        await advance(60000);expect(readCounts()).toEqual(before)
        let resolveRookie!: (value:unknown)=>void
        mocks.rookie.mockReturnValueOnce(new Promise(done=>{resolveRookie=done}))
        let resolve!: (value:unknown)=>void
        mocks.auction.mockReturnValueOnce(new Promise(done=>{resolve=done}))
        await event('online')
        expect(auction.realtimeConnected).toBe(false)
        await act(async()=>{await auction.handleNominate('player');await rookie.handlePick({id:'player'} as Parameters<typeof rookie.handlePick>[0])})
        expect(mocks.bid).not.toHaveBeenCalled()
        expect(mocks.nominate).not.toHaveBeenCalled()
        expect(mocks.pick).not.toHaveBeenCalled()
        await act(async()=>{resolve({draft:{id:'draft',status:'paused'},budgets:[],nominations:[],order:[],activeBids:[],openNomination:null})})
        expect(auction.realtimeConnected).toBe(true)
        expect(rookie.actionsReady).toBe(false)
        await act(async()=>{resolveRookie({draft:{id:'rookie',status:'paused',leagueId:'league',leagueSeasonId:'season',isCurrentSeason:true},picks:[],nextPick:null,orders:[]})})
        expect(rookie.actionsReady).toBe(true)
    })
    it('discards queued launch and room results after a membership switch',async()=>{
        let resolve!: (value:unknown)=>void
        mocks.auction.mockReturnValueOnce(new Promise(done=>{resolve=done}))
        await mount();await event('hidden');await act(async()=>{void launcher.openDraftRoom()})
        await act(async()=>{renderer!.update(React.createElement(Probe,{member:'next-member'}))})
        await act(async()=>{resolve({draft:{id:'old',status:'paused'},budgets:[],nominations:[],order:[],activeBids:[],openNomination:null})})
        expect(auction.state).toBeNull();expect(rookie.state).toBeNull()
        await event('visible')
        expect(mocks.launch).not.toHaveBeenCalled();expect(mocks.push).not.toHaveBeenCalled()
    })
    it('defers unfocused work and catches up once when the route gains focus', async()=>{
        mocks.focused=false
        await mount()
        await act(async()=>{void launcher.openDraftRoom();void auction.refresh();void rookie.refresh()})
        await advance(60000)
        expect(readCounts()).toEqual([0,0,0,0,0,0])
        mocks.focused=true
        await act(async()=>{renderer!.update(React.createElement(Probe))})
        expect(readCounts().slice(0,3)).toEqual([1,1,1])
        expect(mocks.launch).toHaveBeenCalledTimes(1)
    })
    it('rejects callbacks from a signed-out or replaced session before a parent rerender',async()=>{
        await mount()
        const before=readCounts()
        setSessionOwner(null)
        await act(async()=>{void auction.refresh();void rookie.refresh();void launcher.openDraftRoom();mocks.auctionChange?.();mocks.rookieChange?.()})
        await advance(60000)
        expect(readCounts()).toEqual(before)
        setSessionOwner('user-b')
        await act(async()=>{void auction.refresh();void rookie.refresh();void launcher.openDraftRoom()})
        expect(readCounts()).toEqual(before)
        await act(async()=>{renderer!.update(React.createElement(Probe,{member:'new-member'}))})
        expect(mocks.auction).toHaveBeenCalledTimes(before[0]+1)
        expect(mocks.rookie).toHaveBeenCalledTimes(before[1]+1)
        expect(mocks.launch).toHaveBeenCalledTimes(before[5])
    })
    it('keeps failed resume reads pending and actions disabled until retry succeeds',async()=>{
        await mount();await act(async()=>{mocks.auctionStatus?.('SUBSCRIBED')})
        await event('offline')
        mocks.auction.mockRejectedValueOnce(new Error('unavailable'))
        mocks.rookie.mockRejectedValueOnce(new Error('unavailable'))
        await event('online')
        expect(auction.actionsReady).toBe(false);expect(rookie.actionsReady).toBe(false)
        await act(async()=>{await auction.refresh();await rookie.refresh()})
        expect(auction.actionsReady).toBe(true);expect(rookie.actionsReady).toBe(true)
    })

})
