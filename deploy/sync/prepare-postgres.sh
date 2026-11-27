#!/usr/bin/env bash
set -euo pipefail

host=${1:?Usage: bash prepare-postgres.sh PUBLIC_HOST}
if [[ ! "$host" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo 'PUBLIC_HOST must be a domain name or IPv4 address' >&2
    exit 1
fi

umask 077
config_dir=/etc/codelens
postgres_env="$config_dir/postgres.env"
install -d -m 0755 "$config_dir"
if [[ ! -e "$postgres_env" ]]; then
    admin_password=$(openssl rand -hex 32)
    app_password=$(openssl rand -hex 32)
    (set -o noclobber
     printf 'POSTGRES_PASSWORD=%s\nCODELENS_POSTGRES_PASSWORD=%s\n' \
         "$admin_password" "$app_password" > "$postgres_env")
fi
chmod 0600 "$postgres_env"
app_password=$(sed -n 's/^CODELENS_POSTGRES_PASSWORD=//p' "$postgres_env")
[[ "$app_password" =~ ^[0-9a-f]{64}$ ]]

if ! docker container inspect codelens-postgres >/dev/null 2>&1; then
    docker volume create codelens-postgres >/dev/null
    docker run --detach --name codelens-postgres --restart unless-stopped \
        --network host --env-file "$postgres_env" \
        --volume codelens-postgres:/var/lib/postgresql/data postgres:16 \
        -c listen_addresses=127.0.0.1 >/dev/null
elif [[ "$(docker inspect --format '{{.State.Running}}' codelens-postgres)" != true ]]; then
    docker start codelens-postgres >/dev/null
fi

for attempt in $(seq 1 30); do
    if docker exec codelens-postgres pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
        break
    fi
    sleep 2
done
docker exec codelens-postgres pg_isready -h 127.0.0.1 -U postgres
docker exec -i codelens-postgres psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
\getenv app_password CODELENS_POSTGRES_PASSWORD
SELECT format('CREATE ROLE codelens LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'codelens')
\gexec
SELECT 'CREATE DATABASE codelens OWNER codelens'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'codelens')
\gexec
SQL
docker exec codelens-postgres sh -ec \
    'PGPASSWORD="$CODELENS_POSTGRES_PASSWORD" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U codelens -d codelens -c "SELECT 1" >/dev/null'

service_env=$(mktemp "$config_dir/history.env.XXXXXX")
trap 'rm -f -- "$service_env"' EXIT
printf 'CODELENS_SYNC_ORIGIN=https://%s\nCODELENS_SYNC_DATABASE_URL=postgresql://codelens:%s@127.0.0.1:5432/codelens\n' \
    "$host" "$app_password" > "$service_env"
mv -f -- "$service_env" "$config_dir/history.env"
