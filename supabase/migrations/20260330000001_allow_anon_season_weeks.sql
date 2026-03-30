-- Allow anon users to read season_weeks (public reference data)
CREATE POLICY "season_weeks_select_anon" ON season_weeks
  FOR SELECT TO anon USING (true);
