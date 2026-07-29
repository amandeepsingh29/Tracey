-- Ensure every present and future tenant-owned control-plane table is protected
-- even when the application connects as the table owner.
DO $$
DECLARE
  tenant_table record;
  policy_count integer;
BEGIN
  FOR tenant_table IN
    SELECT DISTINCT table_schema, table_name
    FROM information_schema.columns
    WHERE table_schema = 'tracey' AND column_name = 'tenant_id'
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM pg_policies WHERE schemaname = %L AND tablename = %L',
      tenant_table.table_schema,
      tenant_table.table_name
    ) INTO policy_count;
    IF policy_count = 0 THEN
      RAISE EXCEPTION 'Tenant table %.% has no row-level security policy',
        tenant_table.table_schema,
        tenant_table.table_name;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      tenant_table.table_schema,
      tenant_table.table_name
    );
    EXECUTE format(
      'ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY',
      tenant_table.table_schema,
      tenant_table.table_name
    );
  END LOOP;
END
$$;
