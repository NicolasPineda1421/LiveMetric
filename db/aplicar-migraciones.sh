#!/bin/sh
# LiveMetric - Aplica las migraciones de /migraciones, en orden, a la base de
# PGHOST/PGDATABASE/PGUSER/PGPASSWORD. Son idempotentes (IF NOT EXISTS): en
# una base nueva o ya al dia no cambian nada. Lo usa el servicio
# "migraciones" del compose de Docker Hub (imagen livemetric-db).
set -eu
for f in /migraciones/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -f "$f"
  echo "Aplicada (o ya estaba): $(basename "$f")"
done
