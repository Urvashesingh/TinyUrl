#!/bin/sh
# Runs once, on first initialisation of the primary's data directory.
#
# initdb writes a pg_hba.conf with no rule for replication connections, so a
# standby's pg_basebackup is refused before it can even authenticate. This adds
# that rule.
#
# "trust" is a local-development convenience: it lets any host in the compose
# network start replicating with no credentials. A real deployment uses a
# dedicated role with the REPLICATION attribute, scram-sha-256, and a source
# address range narrower than "all".
set -e

cat >> "$PGDATA/pg_hba.conf" <<'RULE'

# Added by docker/postgres/10-replication.sh -- see the Phase 6 notes.
host replication all all trust
RULE
