----------------------------- MODULE LockOrder -----------------------------
EXTENDS Naturals, Sequences, FiniteSets, LockOrderData

Procs == {1, 2}

Rank == [keyshare |-> 1, share |-> 2, nokey |-> 3, update |-> 4]

Clashing == {<<"keyshare", "update">>, <<"share", "nokey">>, <<"share", "update">>,
             <<"nokey", "nokey">>, <<"nokey", "update">>, <<"update", "update">>}

SameRows(a, b) == "*" \in a.states \/ "*" \in b.states \/ a.states \cap b.states # {}

Clash(a, b) ==
  /\ a.res = b.res
  /\ SameRows(a, b)
  /\ (<<a.mode, b.mode>> \in Clashing \/ <<b.mode, a.mode>> \in Clashing)

Covers(h, l) ==
  /\ h.res = l.res
  /\ Rank[h.mode] >= Rank[l.mode]
  /\ ("*" \in h.states \/ ("*" \notin l.states /\ l.states \subseteq h.states))

VARIABLES path, pc, held

vars == <<path, pc, held>>

Done(p) == pc[p] > Len(Paths[path[p]])

Want(p) == Paths[path[p]][pc[p]]

Have(p) == \E h \in held[p] : Covers(h, Want(p))

Free(p) == \A q \in Procs \ {p} : \A h \in held[q] : ~Clash(h, Want(p))

Stuck(p) == ~Done(p) /\ ~Have(p) /\ ~Free(p) /\ Want(p).wait

Init ==
  /\ path \in Pairs
  /\ pc = [p \in Procs |-> 1]
  /\ held = [p \in Procs |-> {}]

Take(p) ==
  /\ ~Done(p)
  /\ Have(p) \/ Free(p)
  /\ pc' = [pc EXCEPT ![p] = @ + 1]
  /\ held' = [held EXCEPT ![p] = IF pc[p] = Len(Paths[path[p]]) THEN {} ELSE @ \cup {Want(p)}]
  /\ UNCHANGED path

GiveUp(p) ==
  /\ ~Done(p)
  /\ ~Have(p)
  /\ ~Free(p)
  /\ ~Want(p).wait
  /\ pc' = [pc EXCEPT ![p] = Len(Paths[path[p]]) + 1]
  /\ held' = [held EXCEPT ![p] = {}]
  /\ UNCHANGED path

Next == \E p \in Procs : Take(p) \/ GiveUp(p)

Spec == Init /\ [][Next]_vars

NoDeadlock == (\A p \in Procs : Done(p)) \/ (\E p \in Procs : ~Done(p) /\ ~Stuck(p))

=============================================================================
