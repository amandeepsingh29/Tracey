# PostgreSQL backup and restore

Tracey control-plane state must be backed up independently from SigNoz telemetry.
Production PostgreSQL should use provider-managed continuous backups plus point-in-time
recovery. The repository commands below provide portable logical backups for release,
migration, and disaster-recovery drills.

Create a checksum-manifested custom-format backup:

```bash
DATABASE_URL=postgresql://... pnpm backup:postgres -- /secure/tracey-2026-07-29.dump
```

If the host PostgreSQL client major version differs from the local server, use
the matching tools already inside Tracey's repository-owned database container:

```bash
TRACEY_PG_TOOLS_CONTAINER=tracey-postgres-postgres-1 \
  DATABASE_URL=postgresql://... \
  pnpm backup:postgres -- /secure/tracey-2026-07-29.dump
```

Restore only into an empty database:

```bash
TRACEY_RESTORE_CONFIRM=RESTORE \
  pnpm restore:postgres -- /secure/tracey-2026-07-29.dump postgresql://.../empty_target
```

The restore refuses a modified backup, a missing confirmation, a non-empty target, or
a migration-count mismatch. Exercise the complete source-backup-target-restore path:

```bash
pnpm verify:backup-restore
```

Production policy:

- retain daily backups for 35 days and monthly backups for 12 months;
- enable point-in-time recovery with a recovery point objective of 15 minutes;
- encrypt backups with the organization KMS and replicate them to another region;
- restrict restore credentials to the database operations role;
- run a quarterly restore drill and retain its generated verification report;
- never count a backup as healthy until a separate database has restored and passed
  the migration and tenant-data checks.
