---- MODULE WorkQueue ----
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Cap, PerDispatch, LiveFirst, Background, MatchupDynamic, Rotate, RotationKinds,
          GateKinds, Gate, LeaseTicks, BackoffTicks, StallRelease, ReleaseAfter, Fenced,
          MaxHolders, Burst, Losses, Backlog, FairBound, StallBound

Kinds == <<"live-poll", "stats-sync", "daily-stat-corrections", "matchup-forecasts", "forecast-inputs", "trade-revaluation-check">>
KindSet == {Kinds[i] : i \in 1..Len(Kinds)}
IdOf == [k \in KindSet |-> CHOOSE i \in 1..Len(Kinds) : Kinds[i] = k]
Id(k) == IdOf[k]
Urgent == {"stats-sync", "daily-stat-corrections"}
Inline == {"daily-stat-corrections", "forecast-inputs"}
FairKinds == KindSet \ {"live-poll", "matchup-forecasts"}
DueAge == [k \in KindSet |-> CASE k = "trade-revaluation-check" -> 6
                               [] k = "forecast-inputs" -> 3
                               [] k \in Urgent -> 1
                               [] OTHER -> 0]

VARIABLES lp, lpAge, lpGap, stale, reclaimed, twice, holders, urgent, burstUsed,
          fiDue, mfReady, tcLeft, order, wait, lpMissed, lastClaims

vars == <<lp, lpAge, lpGap, stale, reclaimed, twice, holders, urgent, burstUsed,
          fiDue, mfReady, tcLeft, order, wait, lpMissed, lastClaims>>

RotationSeq == <<"trade-revaluation-check", "forecast-inputs", "matchup-forecasts">>

Init ==
  /\ lp = "due" /\ lpAge = 0 /\ lpGap = 0
  /\ stale = FALSE /\ reclaimed = FALSE /\ twice = FALSE
  /\ holders = 0
  /\ urgent = [k \in Urgent |-> 0] /\ burstUsed = FALSE
  /\ fiDue = TRUE /\ mfReady = FALSE /\ tcLeft = Backlog
  /\ order = SelectSeq(RotationSeq, LAMBDA k : k \in RotationKinds)
  /\ wait = [k \in FairKinds |-> 0]
  /\ lpMissed = FALSE
  /\ lastClaims = <<>>

IsBg(s, k) ==
  IF k = "matchup-forecasts" /\ MatchupDynamic THEN s.fiDue /\ ~s.mfReady ELSE k \in Background

Pos(seq, k) == IF \E i \in 1..Len(seq) : seq[i] = k THEN CHOOSE i \in 1..Len(seq) : seq[i] = k ELSE 0

Due(s, k) ==
  CASE k = "live-poll" -> s.lpDue
    [] k \in Urgent -> s.urgent[k] > 0
    [] k = "matchup-forecasts" -> s.mfDue
    [] k = "forecast-inputs" -> s.fiDue /\ s.fiAgain
    [] k = "trade-revaluation-check" -> s.tcLeft > 0

Eligible(s, k) ==
  /\ Due(s, k)
  /\ s.running < Cap
  /\ (k \in GateKinds => s.running < Gate)

Key(s, k) ==
  (IF LiveFirst /\ k = "live-poll" THEN 0 ELSE 1) * 100000
  + (IF IsBg(s, k) THEN 1 ELSE 0) * 10000
  + (IF Rotate /\ IsBg(s, k) THEN Pos(s.order, k) ELSE 0) * 1000
  + (10 - DueAge[k]) * 10
  + Id(k)

Pick(s) ==
  LET ready == {k \in KindSet : Eligible(s, k)}
      keys == [k \in ready |-> Key(s, k)]
  IN IF ready = {} THEN "none" ELSE CHOOSE k \in ready : \A j \in ready : keys[k] <= keys[j]

MoveLast(seq, k) == IF Pos(seq, k) = 0 THEN seq ELSE Append(SelectSeq(seq, LAMBDA x : x # k), k)

Apply(s, k, fiMore) ==
  [s EXCEPT !.count = @ + 1,
            !.running = IF k \in Inline THEN @ ELSE @ + 1,
            !.claimed = Append(@, k),
            !.lpDue = IF k = "live-poll" THEN FALSE ELSE @,
            !.urgent = IF k \in Urgent THEN [@ EXCEPT ![k] = @ - 1] ELSE @,
            !.mfDue = IF k = "matchup-forecasts" THEN FALSE ELSE @,
            !.mfReady = CASE k = "matchup-forecasts" -> FALSE [] k = "forecast-inputs" -> TRUE [] OTHER -> @,
            !.fiDue = IF k = "forecast-inputs" THEN fiMore ELSE @,
            !.fiAgain = IF k = "forecast-inputs" THEN FALSE ELSE @,
            !.tcLeft = IF k = "trade-revaluation-check" THEN @ - 1 ELSE @,
            !.order = IF Rotate /\ k \in RotationKinds THEN MoveLast(@, k) ELSE @]

RECURSIVE Loop(_, _)
Loop(s, fiMore) ==
  IF s.count >= PerDispatch THEN s
  ELSE LET k == Pick(s) IN IF k = "none" THEN s ELSE Loop(Apply(s, k, fiMore), fiMore)

Released == StallRelease /\ lp = "lost" /\ lpAge + 1 >= ReleaseAfter
Expired == lp = "lost" /\ lpAge + 1 > LeaseTicks
StartLp ==
  CASE lp = "running" -> "due"
    [] Released -> "due"
    [] Expired -> IF BackoffTicks = 0 THEN "due" ELSE "backoff"
    [] lp = "backoff" /\ lpAge + 1 >= BackoffTicks -> "due"
    [] OTHER -> lp
StartAge ==
  CASE Released -> 0
    [] Expired -> 0
    [] lp \in {"lost", "backoff"} -> lpAge + 1
    [] OTHER -> 0

Tick(h, burst, lose, fiMore, wake) ==
  LET start == StartLp
      held == h + (IF start = "lost" THEN 1 ELSE 0)
      s0 == [count |-> 0, running |-> held, claimed |-> <<>>, lpDue |-> start = "due",
             urgent |-> IF burst THEN [k \in Urgent |-> Burst] ELSE urgent,
             mfDue |-> TRUE, mfReady |-> mfReady, fiDue |-> fiDue \/ fiMore, fiAgain |-> TRUE,
             tcLeft |-> tcLeft, order |-> order]
      s1 == Loop(s0, fiMore)
      claimedSet == {s1.claimed[i] : i \in 1..Len(s1.claimed)}
      lpClaimed == "live-poll" \in claimedSet
  IN
  /\ ~(burst /\ burstUsed)
  /\ ~(lose /\ stale)
  /\ ~(wake /\ ~stale)
  /\ holders' = h
  /\ burstUsed' = (burstUsed \/ burst)
  /\ urgent' = s1.urgent
  /\ fiDue' = s1.fiDue
  /\ mfReady' = s1.mfReady
  /\ tcLeft' = s1.tcLeft
  /\ order' = s1.order
  /\ lastClaims' = s1.claimed
  /\ lp' = IF lpClaimed THEN (IF lose THEN "lost" ELSE "running") ELSE start
  /\ lpAge' = IF lpClaimed THEN 0 ELSE StartAge
  /\ lpGap' = CASE lpClaimed -> 0
               [] lp \in {"lost", "backoff"} \/ lpGap > 0 -> lpGap + 1
               [] OTHER -> 0
  /\ lpMissed' = (start = "due" /\ held < Cap /\ ~lpClaimed)
  /\ reclaimed' = (stale /\ (reclaimed \/ lpClaimed))
  /\ stale' = IF lpClaimed /\ lose THEN TRUE ELSE IF wake /\ Fenced THEN FALSE ELSE stale
  /\ twice' = (twice \/ (wake /\ ~Fenced /\ reclaimed /\ lp \in {"running", "lost"}))
  /\ wait' = [k \in FairKinds |->
               IF Due(s0, k) /\ k \notin claimedSet THEN (IF wait[k] > FairBound THEN wait[k] ELSE wait[k] + 1) ELSE 0]

Next == \E h \in 0..MaxHolders, fiMore \in BOOLEAN,
           burst \in IF burstUsed \/ Burst = 0 THEN {FALSE} ELSE BOOLEAN,
           lose \in IF stale \/ ~Losses THEN {FALSE} ELSE BOOLEAN,
           wake \in IF stale THEN BOOLEAN ELSE {FALSE} :
          Tick(h, burst, lose, fiMore, wake)

Spec == Init /\ [][Next]_vars

LivePollFirst == ~lpMissed
StalledLivePollRetries == lpGap < StallBound
BackgroundKindsRun == \A k \in FairKinds : wait[k] <= FairBound
NoItemRunsTwice == ~twice
====
