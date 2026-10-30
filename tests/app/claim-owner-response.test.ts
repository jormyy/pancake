import { clearPersistentCaches } from '@/lib/persistent-cache'
import React from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import ClaimPlayerScreen from '@/app/(modals)/claim-player'
import { memberTransactionState } from '@/tests/helpers/fixtures'

vi.mock('@/lib/cache/screen-cache', () => ({ cachedScreenView: () => undefined, subscribeScreenView: () => () => {},
    readScreenView: async () => ({ context: { seasonId: 'season' }, player: await state.player(), roster: [], priority: 1, clearsAt: null,
        transactionState: await state.balance(), members: await state.members(), claims: [], taxiExitIds: [] }),
}))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeasonId: async () => 'season' }))

const state=vi.hoisted(()=>({owner:'a',waiverMode:'rolling',balance:vi.fn(),claim:vi.fn(),success:vi.fn(),report:vi.fn(),back:vi.fn(),player:vi.fn(),members:vi.fn()}))
vi.mock('react-native',()=>({View:'View',Text:'Text',Pressable:'Pressable',TextInput:'TextInput',ScrollView:'ScrollView',Platform:{OS:'web'},StyleSheet:{create:(styles:unknown)=>styles},useWindowDimensions:()=>({width:1280,height:900})}))
vi.mock('@expo/vector-icons/MaterialIcons',()=>({default:'Icon'}))
vi.mock('expo-router',()=>({Stack:{Screen:()=>null},useLocalSearchParams:()=>({playerId:'target'}),useRouter:()=>({push:vi.fn()})}))
vi.mock('@/hooks/use-auth',()=>({useAuth:()=>({user:{id:state.owner}})}))
vi.mock('@/contexts/league-context',()=>({useLeagueContext:()=>({current:{id:'member-'+state.owner},currentLeague:{id:'league-'+state.owner,roster_size:20,waiver_mode:state.waiverMode}})}))
vi.mock('@/hooks/use-online-status',()=>({useOnlineStatus:()=>true}))
vi.mock('@/components/ui/useGoBack',()=>({useGoBack:()=>state.back}))
vi.mock('@/components/ui',()=>({LoadingState:'LoadingState',usePageMetrics:()=>({padX:16,usableWidth:1200}),PageHeader:({actions}:{actions:React.ReactNode})=>React.createElement('Header',null,actions)}))
vi.mock('@/components/ui/ScreenFrame',()=>({ScreenFrame:'ScreenFrame'}))
vi.mock('@/components/Avatar',()=>({Avatar:'Avatar'}))
vi.mock('@/components/EmptyState',()=>({EmptyState:'EmptyState'}))
vi.mock('@/lib/league',()=>({getLeagueMembers:state.members}))
vi.mock('@/lib/roster',()=>({getRoster:async()=>[]}))
vi.mock('@/lib/players',()=>({getPlayer:state.player}))
vi.mock('@/lib/waivers',()=>({claimProcessDateLabel:()=> 'Tomorrow',claimProcessTimeLabel:()=> 'tomorrow',getMyWaiverPriority:async()=>1,scheduledClaimLabel: () => 'Tomorrow', getWaiverClearsAt:async()=>null,submitWaiverClaim:state.claim}))
vi.mock('@/lib/roster-add-flow',()=>({loadAddLimitState:state.balance}))
vi.mock('@/lib/format',()=>({isIneligibleIR:()=>false,playerHeadshotUrl:()=>null}))
vi.mock('@/lib/pickup',async importOriginal=>({...await importOriginal<typeof import('@/lib/pickup')>(),addLimitSummary:()=>'',reportPickupError:state.report}))
vi.mock('@/hooks/use-add-limit-gate',()=>({useAddLimitGate:()=>({addBlockedReason:null,explainBlock:()=>false})}))
vi.mock('@/lib/alert',()=>({showAlert:vi.fn(),showSuccess:state.success}))
vi.mock('@/components/IRResolutionModal', () => ({ IRResolutionModal: 'IRResolutionModal' }))
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const render=()=>React.createElement(React.StrictMode,null,React.createElement(ClaimPlayerScreen))
let screen:ReactTestRenderer
const submit=()=>screen.root.findAllByType('Pressable' as React.ElementType).find(node=>node.props.accessibilityLabel==='Submit waiver claim')!
beforeEach(async()=>{activity.active=true;activity.epoch=0;clearPersistentCaches();vi.clearAllMocks();state.owner='a';state.waiverMode='rolling';state.balance.mockResolvedValue(memberTransactionState());state.members.mockImplementation(async()=>[{id:'member-'+state.owner,user_id:state.owner}]);state.player.mockResolvedValue({id:'target',display_name:'Claim target',nba_team:'BOS',eligible_positions:['PG']});state.claim.mockResolvedValue(undefined);await act(async()=>{screen=create(render())})})
afterEach(async()=>{await act(async()=>screen?.unmount())})
it('keeps FAAB bidding visible and blocks claims until the balance retry succeeds', async () => {
    await act(async () => screen.unmount())
    clearPersistentCaches()
    state.waiverMode = 'faab'
    state.balance.mockResolvedValue(null)
    await act(async () => { screen = create(render()) })
    const bid = () => screen.root.findByProps({ accessibilityLabel: 'FAAB bid amount' })
    expect(bid()).toBeDefined()
    expect(submit().props.disabled).toBe(true)
    await act(async () => submit().props.onPress())
    expect(state.claim).not.toHaveBeenCalled()
    expect(screen.root.findAllByType('Text' as React.ElementType).flatMap(node => node.props.children).join(' ')).not.toContain('of $0')
    const retry = screen.root.findByProps({ accessibilityLabel: 'Retry FAAB balance' })
    state.balance.mockResolvedValue(memberTransactionState({ waiverMode: 'faab', faabBalance: 17 }))
    await act(async () => retry.props.onPress())
    expect(submit().props.disabled).toBe(false)
    await act(async () => bid().props.onChangeText('8'))
    await act(async () => submit().props.onPress())
    expect(state.claim).toHaveBeenCalledWith('member-a', 'league-a', 'target', undefined, { bidAmount: 8 })
})
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


const activity = vi.hoisted(() => ({ active: true, epoch: 0 }))
vi.mock('@/components/league/draft-room/useDraftActivity', () => { const gate = {
    canRead: () => activity.active, canAct: () => activity.active,
    capture: () => activity.epoch, isCurrent: (epoch: number) => activity.active && epoch === activity.epoch,
    markReady: () => {}, blockActions: () => {},
}; return { useDraftActivity: () => ({ ...gate, epoch: activity.epoch, ready: activity.active }) } })
beforeEach(() => { activity.active = true; activity.epoch = 0 })

it('defers claim reads while inactive and reloads once on return', async () => {
    await act(async () => screen.unmount())
    state.player.mockClear(); activity.active = false
    await act(async () => { screen = create(render()) })
    expect(state.player).not.toHaveBeenCalled()
    activity.active = true; activity.epoch += 1
    await act(async () => screen.update(render()))
    expect(state.player).toHaveBeenCalledTimes(1)
})

it('does not submit a claim after membership is removed before the click', async () => {
    state.members.mockResolvedValue([])
    await act(async () => submit().props.onPress())
    expect(state.claim).not.toHaveBeenCalled()
})
it('does not submit after suspension while fresh authority is in flight', async () => {
    let finish!: (value: { id: string; user_id: string }[]) => void
    state.members.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    let pending!: Promise<void>
    await act(async () => { pending = submit().props.onPress() })
    activity.active = false; activity.epoch += 1
    await act(async () => screen.update(render()))
    await act(async () => { finish([{id:'member-a',user_id:'a'}]);await pending })
    expect(state.claim).not.toHaveBeenCalled()
})

it('keeps the saved claim visible while a remount revalidates', async () => {
    await act(async () => screen.unmount())
    state.player.mockReturnValue(new Promise(() => {}))
    await act(async () => { screen = create(render()) })
    expect(screen.root.findAllByType('LoadingState' as React.ElementType)).toHaveLength(0)
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === 'Claim target')).toBe(true)
    expect(screen.root.findAll(node => node.props['aria-busy'] === true)).toHaveLength(1)
})
it('shows a retry after the first claim read fails and recovers without leaving the page', async () => {
    await act(async () => screen.unmount())
    clearPersistentCaches()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.player.mockRejectedValue(new Error('offline'))
    await act(async () => { screen = create(render()) })
    expect(screen.root.findAllByType('LoadingState' as React.ElementType)).toHaveLength(0)
    const retry = screen.root.findAllByType('Pressable' as React.ElementType).find(node => node.props.accessibilityLabel === 'Retry waiver claim load')!
    expect(retry).toBeDefined()
    state.player.mockResolvedValue({ id: 'target', display_name: 'Claim target', nba_team: 'BOS', eligible_positions: ['PG'] })
    await act(async () => retry.props.onPress())
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => node.props.children === 'Claim target')).toBe(true)
    error.mockRestore()
})
