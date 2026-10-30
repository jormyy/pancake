CREATE OR REPLACE FUNCTION private.can_receive_live_broadcast(p_topic text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE parts text[]:=string_to_array(p_topic,':'); target uuid;
BEGIN
  IF cardinality(parts)<>3 OR parts[1]<>'l1' OR auth.uid() IS NULL
    OR parts[3]!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  target:=parts[3]::uuid;
  CASE parts[2]
    WHEN 'user' THEN RETURN target=auth.uid();
    WHEN 'member' THEN RETURN EXISTS(SELECT 1 FROM public.league_members WHERE id=target AND user_id=auth.uid());
    WHEN 'league' THEN RETURN EXISTS(SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
      WHERE league.id=target AND league.deleted_at IS NULL AND member.user_id=auth.uid());
    WHEN 'draft' THEN RETURN EXISTS(SELECT 1 FROM public.drafts draft JOIN public.league_members member ON member.league_id=draft.league_id
      JOIN public.leagues league ON league.id=draft.league_id
      WHERE draft.id=target AND league.deleted_at IS NULL AND member.user_id=auth.uid());
    ELSE RETURN false;
  END CASE;
END;
$$;
