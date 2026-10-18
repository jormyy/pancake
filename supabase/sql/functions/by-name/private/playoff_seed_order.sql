CREATE OR REPLACE FUNCTION private.playoff_seed_order(p_size bigint)
RETURNS bigint[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_order bigint[]:=ARRAY[1::bigint,2::bigint]; v_next bigint[]; v_size bigint:=2; v_seed bigint;
BEGIN
  WHILE v_size<p_size LOOP
    v_size:=v_size*2;
    v_next:='{}';
    FOREACH v_seed IN ARRAY v_order LOOP
      v_next:=v_next||ARRAY[v_seed,v_size+1-v_seed];
    END LOOP;
    v_order:=v_next;
  END LOOP;
  RETURN v_order;
END;
$$;
