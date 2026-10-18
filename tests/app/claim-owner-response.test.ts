import React from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import ClaimPlayerScreen from '@/app/(modals)/claim-player'

const state=vi.hoisted(()=>({owner:'a',claim:vi.fn(),success:vi.fn(),report:vi.fn(),back:vi.fn()}))
vi.mock('react-native',()=>({View:'View',Text:'Text',Pressable:'Pressable',TextInput:'TextInput',ScrollView:'ScrollView',Platform:{OS:'web'},StyleSheet:{create:(styles:unknown)=>styles},useWindowDimensions:()=>({width:1280,height:900})}))
vi.mock('@expo/vector-icons/MaterialIcons',()=>({default:'Icon'}))
vi.mock('expo-router',()=>({Stack:{Screen:()=>null},useLocalSearchParams:()=>({playerId:'target'}),useRouter:()=>({push:vi.fn()})}))
vi.mock('@/hooks/use-auth',()=>({useAuth:()=>({user:{id:state.owner}})}))
vi.mock('@/contexts/league-context',()=>({useLeagueContext:()=>({current:{id:'member-'+state.owner},currentLeague:{id:'league-'+state.owner,roster_size:20}})}))
vi.mock('@/hooks/use-online-status',()=>({useOnlineStatus:()=>true}))
vi.mock('@/components/ui/useGoBack',()=>({useGoBack:()=>state.back}))
vi.mock('@/components/ui',()=>({LoadingState:'LoadingState',usePageMetrics:()=>({padX:16,usableWidth:1200}),PageHeader:({actions}:{actions:React.ReactNode})=>React.createElement('Header',null,actions)}))
vi.mock('@/components/ui/ScreenFrame',()=>({ScreenFrame:'ScreenFrame'}))
vi.mock('@/components/Avatar',()=>({Avatar:'Avatar'}))
vi.mock('@/components/EmptyState',()=>({EmptyState:'EmptyState'}))
vi.mock('@/lib/roster',()=>({getRoster:async()=>[]}))
vi.mock('@/lib/players',()=>({getPlayer:async()=>({id:'target',display_name:'Claim target',nba_team:'BOS',eligible_positions:['PG']})}))
vi.mock('@/lib/waivers',()=>({claimProcessDateLabel:()=> 'Tomorrow',claimProcessTimeLabel:()=> 'tomorrow',getMyWaiverPriority:async()=>1,getWaiverClearsAt:async()=>null,submitWaiverClaim:state.claim}))
vi.mock('@/lib/roster-add-flow',()=>({loadAddLimitState:async()=>({weeklyAddCount:0,weeklyAddLimit:7,waiverMode:'rolling'})}))
vi.mock('@/lib/format',()=>({isIneligibleIR:()=>false,playerHeadshotUrl:()=>null}))
vi.mock('@/lib/pickup',()=>({addLimitSummary:()=>'',reportPickupError:state.report}))
vi.mock('@/hooks/use-add-limit-gate',()=>({useAddLimitGate:()=>({addBlockedReason:null,explainBlock:()=>false})}))
vi.mock('@/lib/alert',()=>({showAlert:vi.fn(),showSuccess:state.success}))
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const render=()=>React.createElement(React.StrictMode,null,React.createElement(ClaimPlayerScreen))
let screen:ReactTestRenderer
const submit=()=>screen.root.findAllByType('Pressable' as React.ElementType).find(node=>node.props.accessibilityLabel==='Submit waiver claim')!
beforeEach(async()=>{vi.clearAllMocks();state.owner='a';state.claim.mockResolvedValue(undefined);await act(async()=>{screen=create(render())})})
afterEach(async()=>{await act(async()=>screen?.unmount())})
it('keeps ordinary successful claims and same-owner failures actionable',async()=>{
 state.claim.mockRejectedValueOnce(new Error('Claim failed'))
 await act(async()=>submit().props.onPress())
 expect(state.report).toHaveBeenCalledOnce();expect(state.back).not.toHaveBeenCalled()
 await act(async()=>submit().props.onPress())
 expect(state.success).toHaveBeenCalledOnce();expect(state.back).toHaveBeenCalledOnce()
})
it.each(['success','failure'] as const)('does not deliver a late %s after the claim form closes',async outcome=>{
 let finish!:(value?:unknown)=>void
 state.claim.mockReturnValueOnce(new Promise((resolve,reject)=>{finish=outcome==='success'?resolve:reject}))
 let pending!:Promise<void>
 await act(async()=>{pending=submit().props.onPress()})
 await act(async()=>screen.unmount())
 await act(async()=>{finish(outcome==='failure'?new Error('Old claim failed'):undefined);await pending})
 expect(state.success).not.toHaveBeenCalled();expect(state.report).not.toHaveBeenCalled();expect(state.back).not.toHaveBeenCalled()
})
it.each(['b','a'])('preserves the current %s owner claim after an account switch and late response',async currentOwner=>{
 let finishOld!:()=>void,finishNew!:()=>void
 state.claim.mockReturnValueOnce(new Promise<void>(resolve=>{finishOld=resolve})).mockReturnValueOnce(new Promise<void>(resolve=>{finishNew=resolve}))
 let old!:Promise<void>,next!:Promise<void>
 await act(async()=>{old=submit().props.onPress()})
 state.owner='b';await act(async()=>screen.update(render()))
 if(currentOwner==='a'){state.owner='a';await act(async()=>screen.update(render()))}
 expect(submit().props.disabled).toBe(false)
 await act(async()=>{next=submit().props.onPress()})
 expect(state.claim).toHaveBeenCalledTimes(2)
 await act(async()=>{finishOld();await old})
 expect(submit().props.disabled).toBe(true);expect(state.success).not.toHaveBeenCalled();expect(state.back).not.toHaveBeenCalled()
 await act(async()=>{finishNew();await next})
 expect(state.success).toHaveBeenCalledOnce();expect(state.back).toHaveBeenCalledOnce()
})
