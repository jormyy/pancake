------------------------------ MODULE WaiverRun ------------------------------
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Order, Locking, Workers

Orders == {"run-bid-priority-order", "bid-priority-order", "player-then-bid-priority-order"}
Lockings == {"try-defer", "block-after-league"}

ASSUME Order \in Orders
ASSUME Locking \in Lockings

None == "none"
Leagues == {"L1", "L2"}
Teams == {"A", "B", "C"}
TeamLeague == [t \in Teams |-> IF t = "C" THEN "L2" ELSE "L1"]
Players == {"p1", "p2", "p3", "p4", "pd"}
PlayerRank == [p1 |-> 1, p2 |-> 2, p3 |-> 3, p4 |-> 4, pd |-> 5]
Claims == {"c1", "c2", "c3", "c4", "c5"}
ClaimRank == [c1 |-> 1, c2 |-> 2, c3 |-> 3, c4 |-> 4, c5 |-> 5]
Claim == [
  c1 |-> [team |-> "A", player |-> "p2", bid |-> 1, order |-> 1, run |-> 1, drop |-> "pd"],
  c2 |-> [team |-> "A", player |-> "p1", bid |-> 1, order |-> 2, run |-> 1, drop |-> "pd"],
  c3 |-> [team |-> "B", player |-> "p1", bid |-> 1, order |-> 1, run |-> 1, drop |-> None],
  c4 |-> [team |-> "B", player |-> "p3", bid |-> 5, order |-> 2, run |-> 2, drop |-> None],
  c5 |-> [team |-> "C", player |-> "p4", bid |-> 0, order |-> 1, run |-> 1, drop |-> None]
]
StartFaab == [A |-> 5, B |-> 5, C |-> 0]
StartRoom == [A |-> 0, B |-> 2, C |-> 1]
StartPriority == [A |-> 1, B |-> 2, C |-> 1]
StartOwner == [p \in Players |-> IF p = "pd" THEN "A" ELSE None]
MaxBid == 10

Mutations == {"holdA", "holdC"}
Mutation == [
  holdA |-> [team |-> "A", player |-> "pd"],
  holdC |-> [team |-> "C", player |-> None]
]

Actors == Workers \cup Mutations
LeagueOf(c) == TeamLeague[Claim[c].team]
LeagueLock(l) == <<"league", l>>
Locks == {LeagueLock(l) : l \in Leagues} \cup {<<"team", t>> : t \in Teams} \cup {<<"player", p>> : p \in Players}

VARIABLES status, owner, room, faab, priority, held, pc, target, attempt, snap, mstate, passed

vars == <<status, owner, room, faab, priority, held, pc, target, attempt, snap, mstate, passed>>

ClaimLocks(c) ==
  <<<<"team", Claim[c].team>>>> \o
    IF Claim[c].drop = None THEN <<<<"player", Claim[c].player>>>>
    ELSE IF PlayerRank[Claim[c].player] < PlayerRank[Claim[c].drop]
         THEN <<<<"player", Claim[c].player>>, <<"player", Claim[c].drop>>>>
         ELSE <<<<"player", Claim[c].drop>>, <<"player", Claim[c].player>>>>

RECURSIVE Lex(_, _)
Lex(a, b) ==
  IF a = <<>> THEN FALSE
  ELSE IF Head(a) < Head(b) THEN TRUE
  ELSE IF Head(a) > Head(b) THEN FALSE
  ELSE Lex(Tail(a), Tail(b))

MinBy(set, key(_)) == CHOOSE c \in set : \A d \in set \ {c} : Lex(key(c), key(d))

Due(l) == {c \in Claims : LeagueOf(c) = l /\ status[c] = "pending"}

RunKey(c) == <<Claim[c].run, MaxBid - Claim[c].bid, priority[Claim[c].team], Claim[c].order, ClaimRank[c]>>
BidKey(c) == <<MaxBid - Claim[c].bid, priority[Claim[c].team], Claim[c].order, ClaimRank[c]>>

FirstRun(l, p) == CHOOSE r \in {Claim[c].run : c \in {d \in Due(l) : Claim[d].player = p}} :
  \A c \in Due(l) : Claim[c].player = p => r <= Claim[c].run
PlayerKey(l, p) == <<FirstRun(l, p), PlayerRank[p]>>
NextPlayer(l) ==
  LET due == {Claim[c].player : c \in Due(l)}
  IN CHOOSE p \in due : \A q \in due \ {p} : Lex(PlayerKey(l, p), PlayerKey(l, q))

SpecHead(l) == MinBy(Due(l), RunKey)

PickHead(l) ==
  CASE Order = "run-bid-priority-order" -> SpecHead(l)
    [] Order = "bid-priority-order" -> MinBy(Due(l), BidKey)
    [] Order = "player-then-bid-priority-order" ->
         MinBy({c \in Due(l) : Claim[c].player = NextPlayer(l)}, BidKey)

FreeFor(a, k) == held[k] \in {None, a}

Missing(w) == {i \in 1..Len(ClaimLocks(target[w])) : held[ClaimLocks(target[w])[i]] # w}
NextLock(w) == ClaimLocks(target[w])[CHOOSE i \in Missing(w) : \A j \in Missing(w) : i <= j]
Busy(w) == pc[w] = "lock" /\ Missing(w) # {} /\ held[NextLock(w)] # None

SumBids(cs) ==
  LET RECURSIVE S(_) S(x) == IF x = {} THEN 0 ELSE LET c == CHOOSE y \in x : TRUE IN Claim[c].bid + S(x \ {c})
  IN S(cs)

Won(t) == {c \in Claims : Claim[c].team = t /\ status[c] = "won"}

TypeOK ==
  /\ status \in [Claims -> {"pending", "won", "lost", "failed", "cancelled"}]
  /\ owner \in [Players -> Teams \cup {None}]
  /\ held \in [Locks -> Actors \cup {None}]
  /\ pc \in [Workers -> {"idle", "run", "lock", "wait"}]
  /\ attempt \in [Workers -> SUBSET Locks]
  /\ mstate \in [Mutations -> {"ready", "holding", "done"}]

PlayerAwardedOnce ==
  \A p \in Players : Cardinality({c \in Claims : Claim[c].player = p /\ status[c] = "won"}) <= 1

WinnerOwnsPlayer ==
  \A c \in Claims : status[c] = "won" => owner[Claim[c].player] = Claim[c].team

FaabSpentOnlyOnWins ==
  \A t \in Teams : faab[t] + SumBids(Won(t)) = StartFaab[t]

AwardFollowsWaiverOrder == passed = None

NoWaitWhileHoldingAnotherLeague ==
  \A w \in Workers : pc[w] = "wait" =>
    \A l \in Leagues \ {LeagueOf(target[w])} : held[LeagueLock(l)] # w

Init ==
  /\ status = [c \in Claims |-> "pending"]
  /\ owner = StartOwner
  /\ room = StartRoom
  /\ faab = StartFaab
  /\ priority = StartPriority
  /\ held = [k \in Locks |-> None]
  /\ pc = [w \in Workers |-> "idle"]
  /\ target = [w \in Workers |-> None]
  /\ attempt = [w \in Workers |-> {}]
  /\ snap = [w \in Workers |-> None]
  /\ mstate = [m \in Mutations |-> "ready"]
  /\ passed = None

Resolve(c) ==
  LET t == Claim[c].team
      p == Claim[c].player
      d == Claim[c].drop
      l == LeagueOf(c)
      wins == /\ owner[p] = None
              /\ faab[t] >= Claim[c].bid
              /\ IF d = None THEN room[t] > 0 ELSE owner[d] = t
      top == 1 + CHOOSE m \in {priority[u] : u \in {v \in Teams : TeamLeague[v] = l}} :
               \A u \in Teams : TeamLeague[u] = l => priority[u] <= m
  IN
  IF ~wins THEN
    /\ status' = [status EXCEPT ![c] = IF owner[p] = None THEN "failed" ELSE "lost"]
    /\ UNCHANGED <<owner, room, faab, priority, passed>>
  ELSE
    /\ status' = [x \in Claims |->
         CASE x = c -> "won"
           [] status[x] = "pending" /\ Claim[x].player = p -> "lost"
           [] status[x] = "pending" /\ d # None /\ Claim[x].team = t /\ Claim[x].drop = d -> "cancelled"
           [] OTHER -> status[x]]
    /\ owner' = IF d = None THEN [owner EXCEPT ![p] = t] ELSE [owner EXCEPT ![p] = t, ![d] = None]
    /\ room' = IF d = None THEN [room EXCEPT ![t] = @ - 1] ELSE room
    /\ faab' = [faab EXCEPT ![t] = @ - Claim[c].bid]
    /\ priority' = [priority EXCEPT ![t] = top]
    /\ passed' = IF c = SpecHead(l) THEN None ELSE <<c, SpecHead(l)>>

Remember(w, k) ==
  LET s == snap[w]
      fresh(x) == x = k /\ held[k] # w
  IN [status |-> [c \in Claims |-> IF fresh(LeagueLock(LeagueOf(c))) THEN status[c] ELSE s.status[c]],
      owner |-> [p \in Players |-> IF fresh(<<"player", p>>) THEN owner[p] ELSE s.owner[p]],
      room |-> [t \in Teams |-> IF fresh(<<"team", t>>) THEN room[t] ELSE s.room[t]],
      faab |-> [t \in Teams |-> IF fresh(<<"team", t>>) THEN faab[t] ELSE s.faab[t]],
      priority |-> [t \in Teams |-> IF fresh(<<"team", t>>) THEN priority[t] ELSE s.priority[t]]]

Take(w, k) ==
  /\ held' = [held EXCEPT ![k] = w]
  /\ attempt' = [attempt EXCEPT ![w] = IF held[k] = w THEN @ ELSE @ \cup {k}]
  /\ snap' = [snap EXCEPT ![w] = Remember(w, k)]

BeginBatch(w) ==
  /\ pc[w] = "idle"
  /\ \E l \in Leagues : Due(l) # {}
  /\ pc' = [pc EXCEPT ![w] = "run"]
  /\ snap' = [snap EXCEPT ![w] = [status |-> status, owner |-> owner, room |-> room, faab |-> faab, priority |-> priority]]
  /\ UNCHANGED <<status, owner, room, faab, priority, held, target, attempt, mstate, passed>>

TryLeague(w, l) ==
  /\ pc[w] = "run"
  /\ Due(l) # {}
  /\ FreeFor(w, LeagueLock(l))
  /\ Take(w, LeagueLock(l))
  /\ pc' = [pc EXCEPT ![w] = "lock"]
  /\ target' = [target EXCEPT ![w] = PickHead(l)]
  /\ UNCHANGED <<status, owner, room, faab, priority, mstate, passed>>

TakeLock(w) ==
  /\ pc[w] \in {"lock", "wait"}
  /\ Missing(w) # {}
  /\ held[NextLock(w)] = None
  /\ Take(w, NextLock(w))
  /\ pc' = [pc EXCEPT ![w] = "lock"]
  /\ UNCHANGED <<status, owner, room, faab, priority, target, mstate, passed>>

BlockOnBusyLock(w) ==
  /\ Locking = "block-after-league"
  /\ Busy(w)
  /\ pc' = [pc EXCEPT ![w] = "wait"]
  /\ UNCHANGED <<status, owner, room, faab, priority, held, target, attempt, snap, mstate, passed>>

DeferBusyAttempt(w) ==
  /\ Locking = "try-defer"
  /\ Busy(w)
  /\ held' = [k \in Locks |-> IF k \in attempt[w] THEN None ELSE held[k]]
  /\ pc' = [pc EXCEPT ![w] = "run"]
  /\ target' = [target EXCEPT ![w] = None]
  /\ attempt' = [attempt EXCEPT ![w] = {}]
  /\ UNCHANGED <<status, owner, room, faab, priority, snap, mstate, passed>>

ResolveLocked(w) ==
  /\ pc[w] = "lock"
  /\ Missing(w) = {}
  /\ Resolve(target[w])
  /\ pc' = [pc EXCEPT ![w] = "run"]
  /\ target' = [target EXCEPT ![w] = None]
  /\ attempt' = [attempt EXCEPT ![w] = {}]
  /\ UNCHANGED <<held, snap, mstate>>

Release(a) == [k \in Locks |-> IF held[k] = a THEN None ELSE held[k]]

CommitBatch(w) ==
  /\ pc[w] = "run"
  /\ held' = Release(w)
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ snap' = [snap EXCEPT ![w] = None]
  /\ UNCHANGED <<status, owner, room, faab, priority, target, attempt, mstate, passed>>

AbortBatch(w) ==
  LET s == snap[w]
      mine(k) == held[k] = w
  IN
  /\ pc[w] # "idle"
  /\ status' = [c \in Claims |-> IF mine(LeagueLock(LeagueOf(c))) THEN s.status[c] ELSE status[c]]
  /\ owner' = [p \in Players |-> IF mine(<<"player", p>>) THEN s.owner[p] ELSE owner[p]]
  /\ room' = [t \in Teams |-> IF mine(<<"team", t>>) THEN s.room[t] ELSE room[t]]
  /\ faab' = [t \in Teams |-> IF mine(<<"team", t>>) THEN s.faab[t] ELSE faab[t]]
  /\ priority' = [t \in Teams |-> IF mine(<<"team", t>>) THEN s.priority[t] ELSE priority[t]]
  /\ held' = Release(w)
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ target' = [target EXCEPT ![w] = None]
  /\ attempt' = [attempt EXCEPT ![w] = {}]
  /\ snap' = [snap EXCEPT ![w] = None]
  /\ UNCHANGED <<mstate, passed>>

MutationLocks(m) == {<<"team", Mutation[m].team>>} \cup IF Mutation[m].player = None THEN {} ELSE {<<"player", Mutation[m].player>>}

MutationBegins(m) ==
  /\ mstate[m] = "ready"
  /\ \A k \in MutationLocks(m) : held[k] = None
  /\ held' = IF Mutation[m].player = None THEN [held EXCEPT ![<<"team", Mutation[m].team>>] = m]
             ELSE [held EXCEPT ![<<"team", Mutation[m].team>>] = m, ![<<"player", Mutation[m].player>>] = m]
  /\ mstate' = [mstate EXCEPT ![m] = "holding"]
  /\ UNCHANGED <<status, owner, room, faab, priority, pc, target, attempt, snap, passed>>

MutationEnds(m) ==
  /\ mstate[m] = "holding"
  /\ held' = Release(m)
  /\ mstate' = [mstate EXCEPT ![m] = "done"]
  /\ UNCHANGED <<status, owner, room, faab, priority, pc, target, attempt, snap, passed>>

Next ==
  \/ \E w \in Workers :
       \/ BeginBatch(w) \/ TakeLock(w) \/ BlockOnBusyLock(w) \/ DeferBusyAttempt(w) \/ ResolveLocked(w)
       \/ CommitBatch(w) \/ AbortBatch(w)
       \/ \E l \in Leagues : TryLeague(w, l)
  \/ \E m \in Mutations : MutationBegins(m) \/ MutationEnds(m)

Spec == Init /\ [][Next]_vars
=============================================================================
