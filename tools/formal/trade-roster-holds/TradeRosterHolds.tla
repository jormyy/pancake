---------------------------- MODULE TradeRosterHolds ----------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Rule, Offers, RosterSize

Rules == {"unanimous-only", "every-acceptance"}

ASSUME Rule \in Rules
ASSUME RosterSize \in Nat \ {0}

VARIABLES active, status, held, claim, room

vars == <<active, status, held, claim, room>>

Unanimous == {t \in Offers : status[t] = "accepted"}

OpenHolds == {t \in Offers : status[t] = "pending" /\ held[t]}

Fits(extra, offers) == active + extra + Cardinality(offers) <= RosterSize

Views ==
  IF Rule = "unanimous-only"
  THEN {Unanimous}
  ELSE {Unanimous} \cup {Unanimous \cup {t} : t \in OpenHolds}

RosterGuard(extra) == \A view \in Views : Fits(extra, view)

OtherHoldsFit(t, base) ==
  Rule = "every-acceptance" => \A o \in OpenHolds \ {t} : Fits(0, base \cup {o})

AcceptanceFits(t) ==
  /\ Fits(0, Unanimous \cup {t})
  /\ OtherHoldsFit(t, Unanimous)

FinalYesFits(t) ==
  /\ Fits(0, Unanimous \cup {t})
  /\ OtherHoldsFit(t, Unanimous \cup {t})

ClaimEntryFits == Rule = "every-acceptance" => RosterGuard(1)

HasRoomNext(t) ==
  active' + Cardinality({o \in Offers : status'[o] = "accepted"}) + 1 <= RosterSize

TrackRoom ==
  room' = [t \in Offers |-> status'[t] = "pending" /\ held'[t] /\ (room[t] \/ HasRoomNext(t))]

Init ==
  /\ active \in 0..RosterSize
  /\ status \in [Offers -> {"unsent", "pending"}]
  /\ held = [t \in Offers |-> FALSE]
  /\ claim = "none"
  /\ room = [t \in Offers |-> FALSE]

TeamProposes(t) ==
  /\ status[t] = "unsent"
  /\ status' = [status EXCEPT ![t] = "pending"]
  /\ held' = [held EXCEPT ![t] = TRUE]
  /\ UNCHANGED <<active, claim>>
  /\ TrackRoom

TeamAccepts(t) ==
  /\ status[t] = "pending"
  /\ ~held[t]
  /\ AcceptanceFits(t)
  /\ held' = [held EXCEPT ![t] = TRUE]
  /\ UNCHANGED <<active, status, claim>>
  /\ TrackRoom

TeamWithdraws(t) ==
  /\ Rule = "every-acceptance"
  /\ status[t] = "pending"
  /\ held[t]
  /\ held' = [held EXCEPT ![t] = FALSE]
  /\ UNCHANGED <<active, status, claim>>
  /\ TrackRoom

PartnerFinalYes(t) ==
  /\ status[t] = "pending"
  /\ held[t]
  /\ FinalYesFits(t)
  /\ status' = [status EXCEPT ![t] = "accepted"]
  /\ UNCHANGED <<active, held, claim>>
  /\ TrackRoom

PartnerDeclines(t) ==
  /\ status[t] = "pending"
  /\ status' = [status EXCEPT ![t] = "declined"]
  /\ UNCHANGED <<active, held, claim>>
  /\ TrackRoom

TradeCompletes(t) ==
  /\ status[t] = "accepted"
  /\ status' = [status EXCEPT ![t] = "completed"]
  /\ active' = active + 1
  /\ UNCHANGED <<held, claim>>
  /\ TrackRoom

TeamEntersClaim ==
  /\ claim # "waiting"
  /\ ClaimEntryFits
  /\ claim' = "waiting"
  /\ UNCHANGED <<active, status, held>>
  /\ TrackRoom

WaiversRun ==
  /\ claim = "waiting"
  /\ IF RosterGuard(1)
     THEN /\ active' = active + 1
          /\ claim' = "won"
     ELSE /\ claim' = "failed"
          /\ UNCHANGED active
  /\ UNCHANGED <<status, held>>
  /\ TrackRoom

TeamDropsPlayer ==
  /\ active > 0
  /\ active' = active - 1
  /\ UNCHANGED <<status, held, claim>>
  /\ TrackRoom

Next ==
  \/ \E t \in Offers :
       \/ TeamProposes(t)
       \/ TeamAccepts(t)
       \/ TeamWithdraws(t)
       \/ PartnerFinalYes(t)
       \/ PartnerDeclines(t)
       \/ TradeCompletes(t)
  \/ TeamEntersClaim
  \/ WaiversRun
  \/ TeamDropsPlayer

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ active \in Nat
  /\ status \in [Offers -> {"unsent", "pending", "accepted", "declined", "completed"}]
  /\ held \in [Offers -> BOOLEAN]
  /\ claim \in {"none", "waiting", "won", "failed"}
  /\ room \in [Offers -> BOOLEAN]

AcceptedOffersKeepRoom ==
  \A t \in OpenHolds : room[t] => Fits(0, Unanimous \cup {t})

UnanimousTradesKeepRoom == Fits(0, Unanimous)

RosterWithinLimit == active <= RosterSize

NoWaiverClaimRefused == claim # "failed"

ArchivedWaiverOrder ==
  /\ \A t \in Offers : held'[t] /\ ~held[t] => claim = "waiting" /\ status[t] = "unsent"
  /\ claim = "waiting" /\ claim' # "waiting" => \E t \in Offers : held[t]
=============================================================================
