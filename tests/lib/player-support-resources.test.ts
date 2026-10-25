import {beforeEach,expect,it,vi} from 'vitest'
import {loadPlayerSupport} from '@/lib/player-availability'

const state=vi.hoisted(()=>({season:'season',day:'2026-10-18',owned:vi.fn(),waivers:vi.fn(),claims:vi.fn(),transactions:vi.fn()}))
vi.mock('@/lib/shared/season',()=>({getCurrentSeasonId:async()=>state.season,getLatestSeasonId:async()=>null}))
vi.mock('@/lib/shared/dates',()=>({todayET:()=>state.day}))
vi.mock('@/lib/roster',()=>({getOwnedPlayerMapForSeason:state.owned}))
vi.mock('@/lib/waivers',()=>({getWaiverClearsAtForSeason:state.waivers,getPendingWaiverPlayerIdsForSeason:state.claims}))
vi.mock('@/lib/league',()=>({getMemberTransactionState:state.transactions}))
beforeEach(()=>{
 vi.clearAllMocks();state.season='season';state.day='2026-10-18'
 state.owned.mockResolvedValue(new Map([['owned',{teamName:'Mine',memberId:'member',isOnIR:true}],['other',{teamName:'Other',memberId:'other',isOnIR:true}]]))
 state.waivers.mockResolvedValue(new Map([['wire','2099-01-01T00:00:00Z']]))
 state.claims.mockResolvedValue(new Set(['claimed']))
 state.transactions.mockResolvedValue({faabBalance:20})
})
const counts=()=>[state.owned,state.waivers,state.claims,state.transactions].map(read=>read.mock.calls.length)
it.each(['ownership','waivers','claims','transactions'] as const)('reloads only changed %s and retains the other authoritative resources',async resource=>{
 const previous=await loadPlayerSupport('member','league')
 for(const read of [state.owned,state.waivers,state.claims,state.transactions])read.mockClear()
 state.owned.mockResolvedValue(new Map([['new',{teamName:'New',memberId:'member',isOnIR:false}]]))
 state.waivers.mockResolvedValue(new Map())
 state.claims.mockResolvedValue(new Set())
 state.transactions.mockResolvedValue({faabBalance:10})
 const next=await loadPlayerSupport('member','league',{previous,resources:[resource]})
 expect(counts()).toEqual(['ownership','waivers','claims','transactions'].map(key=>Number(key===resource)))
 expect([...next.ownedMap.keys()]).toEqual(resource==='ownership'?['new']:['owned','other'])
 expect(next.ownedMap.get(resource==='ownership'?'new':'owned')?.isOnIR).toBe(resource!=='ownership')
 if(resource!=='ownership')expect(next.ownedMap).toBe(previous.ownedMap)
 expect([...next.waiverIds]).toEqual(resource==='waivers'?[]:['wire'])
 expect([...next.pendingClaimIds]).toEqual(resource==='claims'?[]:['claimed'])
 expect(next.transactionState?.faabBalance).toBe(resource==='transactions'?10:20)
})
it.each(['member','league','season','day'] as const)('reloads every resource after %s changes',async boundary=>{
 const previous=await loadPlayerSupport('member','league')
 for(const read of [state.owned,state.waivers,state.claims,state.transactions])read.mockClear()
 if(boundary==='season')state.season='next-season'
 if(boundary==='day')state.day='2026-10-19'
 await loadPlayerSupport(boundary==='member'?'other':'member',boundary==='league'?'other':'league',{previous,resources:['claims']})
 expect(counts()).toEqual([1,1,1,1])
})
it('keeps a failed partial read from changing the prior snapshot and permits an authoritative retry',async()=>{
 const previous=await loadPlayerSupport('member','league')
 state.claims.mockRejectedValueOnce(new Error('Claim read failed'))
 await expect(loadPlayerSupport('member','league',{previous,resources:['claims']})).rejects.toThrow('Claim read failed')
 expect([...previous.pendingClaimIds]).toEqual(['claimed'])
 expect(previous.ownedMap.get('owned')?.isOnIR).toBe(true)
 state.claims.mockResolvedValue(new Set())
 expect([...(await loadPlayerSupport('member','league',{previous,resources:['claims']})).pendingClaimIds]).toEqual([])
})
