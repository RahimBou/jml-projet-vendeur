#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

# Run as root from a complete local checkout/extracted source archive.
# This script NEVER deletes databases or overwrites an existing application directory.
if [[ "$EUID" -ne 0 ]]; then
  echo "ERREUR: lancer avec sudo/root." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="/opt/jml-projet-vendeur"
ENV_FILE="/etc/jml-projet-vendeur.env"
SERVICE_FILE="/etc/systemd/system/jml-projet-vendeur.service"
NGINX_FILE="/etc/nginx/sites-available/jml-projet-vendeur"
DB_NAME="jml_projet_vendeur"
DB_USER="jml_app"
DB_PASSWORD_FILE="/root/jml-projet-vendeur-db-password.txt"
ADMIN_PASSWORD_FILE="/root/jml-projet-vendeur-admin-password.txt"

[[ -f "$SOURCE_DIR/server.js" ]] || { echo "ERREUR: server.js absent; archive source incomplète."; exit 1; }
[[ -f "$SOURCE_DIR/db/schema.sql" ]] || { echo "ERREUR: db/schema.sql absent."; exit 1; }
[[ -f "$SOURCE_DIR/package.json" ]] || { echo "ERREUR: package.json absent."; exit 1; }
if [[ -e "$APP_DIR" ]]; then
  echo "ERREUR: $APP_DIR existe déjà. Aucun fichier n'a été remplacé; inspecter l'installation précédente avant de relancer." >&2
  exit 1
fi
if [[ -e "$ENV_FILE" || -e "$SERVICE_FILE" || -e "$NGINX_FILE" ]]; then
  echo "ERREUR: une configuration JML existe déjà (/etc). Arrêt sans écrasement." >&2
  exit 1
fi

echo "== 1/8 Installation des dépendances système =="
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg nginx postgresql postgresql-client rsync openssl

echo "== 2/8 Installation de Node.js 22 LTS =="
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi
node --version
npm --version

echo "== 3/8 Préparation de PostgreSQL =="
systemctl enable --now postgresql
if ! id jml >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin jml
fi
if runuser -u postgres -- psql -X -At -c "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -qx 1; then
  echo "ERREUR: le rôle PostgreSQL $DB_USER existe déjà; arrêt pour éviter une incohérence de mot de passe." >&2
  exit 1
fi
if runuser -u postgres -- psql -X -At -c "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -qx 1; then
  echo "ERREUR: la base $DB_NAME existe déjà; arrêt sans modification." >&2
  exit 1
fi

DB_PASSWORD="$(openssl rand -hex 32)"
ADMIN_PASSWORD="$(openssl rand -hex 24)"
printf '%s\n' "$DB_PASSWORD" > "$DB_PASSWORD_FILE"
printf '%s\n' "$ADMIN_PASSWORD" > "$ADMIN_PASSWORD_FILE"
chmod 0600 "$DB_PASSWORD_FILE" "$ADMIN_PASSWORD_FILE"

runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 \
  --set=db_password="$DB_PASSWORD" --set=db_user="$DB_USER" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password') \gexec
SQL
runuser -u postgres -- createdb --owner="$DB_USER" "$DB_NAME"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -c \
  "ALTER DATABASE $DB_NAME OWNER TO $DB_USER;"

echo "== 4/8 Copie du code dans le serveur =="
install -d -o jml -g jml -m 0750 "$APP_DIR"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='node_modules/' \
  --exclude='.env' \
  --exclude='render.yaml' \
  "$SOURCE_DIR/" "$APP_DIR/"
chown -R jml:jml "$APP_DIR"

echo "== 5/8 Installation des dépendances Node =="
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  runuser -u jml -- npm ci --omit=dev --ignore-scripts
else
  runuser -u jml -- npm install --omit=dev --ignore-scripts
fi
node --check "$APP_DIR/server.js"
node -e 'for (const p of ["express","pg","google-auth-library"]) require.resolve(p); console.log("Dépendances Node critiques présentes.")'

echo "== 6/8 Configuration privée et schéma PostgreSQL =="
cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=10000
DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
DATABASE_SSL=false
JML_ADMIN_PASSWORD=$ADMIN_PASSWORD
JML_REGION=Ardennes
JML_SECTOR=Charleville-Mézières
EOF
chmod 0640 "$ENV_FILE"
chown root:jml "$ENV_FILE"

runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 \
  --dbname="$DB_NAME" --command="GRANT ALL ON SCHEMA public TO $DB_USER;"
runuser -u jml -- env PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U "$DB_USER" \
  -d "$DB_NAME" -X -v ON_ERROR_STOP=1 -f "$APP_DIR/db/schema.sql"

echo "== 7/8 Service systemd et Nginx =="
cat > "$SERVICE_FILE" <<'UNIT'
[Unit]
Description=JML Immobilier — application locale
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=jml
Group=jml
WorkingDirectory=/opt/jml-projet-vendeur
EnvironmentFile=/etc/jml-projet-vendeur.env
ExecStart=/usr/bin/node /opt/jml-projet-vendeur/server.js
Restart=on-failure
RestartSec=5
TimeoutStartSec=60
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/jml-projet-vendeur

[Install]
WantedBy=multi-user.target
UNIT

cat > "$NGINX_FILE" <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name jml.immo www.jml.immo;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:10000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
NGINX

ln -sfn "$NGINX_FILE" /etc/nginx/sites-enabled/jml-projet-vendeur
if [[ -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl enable --now nginx
systemctl daemon-reload
systemctl enable jml-projet-vendeur.service
systemctl start jml-projet-vendeur.service

echo "== 8/8 Vérifications locales =="
HEALTH_OK=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:10000/health -o /tmp/jml-health.json \
    && node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync("/tmp/jml-health.json","utf8")); if(x.ok!==true || x.service!=="jml-projet-vendeur") process.exit(1)' ; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done
if [[ "$HEALTH_OK" -ne 1 ]]; then
  echo "ERREUR: le contrôle /health a échoué. L'installation n'est PAS déclarée réussie." >&2
  systemctl --no-pager --full status jml-projet-vendeur.service || true
  journalctl -u jml-projet-vendeur.service -n 100 --no-pager || true
  exit 1
fi

echo "Vérification PostgreSQL et initialisation applicative..."
if ! runuser -u jml -- env PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -X -v ON_ERROR_STOP=1 -At -c 'SELECT 1' | grep -qx 1; then
  echo "ERREUR: PostgreSQL ne répond pas avec les identifiants de l'application." >&2
  journalctl -u jml-projet-vendeur.service -n 100 --no-pager || true
  exit 1
fi
DB_READY=0
for attempt in $(seq 1 20); do
  if journalctl -u jml-projet-vendeur.service -n 250 --no-pager 2>/dev/null | grep -Fq "database ready"; then
    DB_READY=1
    break
  fi
  if ! systemctl is-active --quiet jml-projet-vendeur.service; then
    break
  fi
  sleep 2
done
if [[ "$DB_READY" -ne 1 ]]; then
  echo "ERREUR: l'application répond en HTTP mais n'a pas confirmé l'initialisation PostgreSQL." >&2
  systemctl --no-pager --full status jml-projet-vendeur.service || true
  journalctl -u jml-projet-vendeur.service -n 100 --no-pager || true
  exit 1
fi
cat /tmp/jml-health.json
echo
echo "INSTALLATION LOCALE VALIDÉE: le service répond et /health confirme le bon service."
echo "Base : $DB_NAME"
echo "Secrets enregistrés dans $DB_PASSWORD_FILE et $ADMIN_PASSWORD_FILE (root uniquement)."
echo "Variables d'environnement : $ENV_FILE"
echo "Service : systemctl status jml-projet-vendeur --no-pager"
echo "Nginx écoute en HTTP; configurer HTTPS uniquement après validation DNS de jml.immo."
echo "Ce serveur ne nécessite pas Render ni GitHub Actions pour fonctionner après installation."
