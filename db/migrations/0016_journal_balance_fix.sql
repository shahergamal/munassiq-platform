-- 0015's balance check read NEW.entry_id on journal_entries rows too (PL/pgSQL resolves both CASE branches).
-- Read the id through JSON so the same function serves both tables.
CREATE OR REPLACE FUNCTION journal_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE _id uuid := (to_jsonb(NEW) ->> CASE WHEN TG_TABLE_NAME = 'journal_entries' THEN 'id' ELSE 'entry_id' END)::uuid;
        _d numeric; _c numeric; _n int;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO _d, _c, _n FROM journal_lines WHERE entry_id = _id;
  IF _n < 2 OR _d <> _c OR _d = 0 THEN RAISE EXCEPTION 'journal_unbalanced' USING ERRCODE = 'P0001'; END IF;
  RETURN NULL;
END $$;
