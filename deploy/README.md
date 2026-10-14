# Portable Relo deployment

From the repository root:

```sh
./deploy/init-secrets.sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
curl --fail http://127.0.0.1:8180/health/ready
```

The first start applies migrations automatically, creates the restricted runtime database role,
and starts the API and worker. APNs is disabled until its values and `secrets/apns_key.p8` are
configured. The server consumes `deploy/secrets/owner_token` internally to bootstrap the single
owner; do not paste it into the Dashboard. Open `RELO_APP_URL`: until an owner exists it shows the
**Create the owner account** form. Once the account exists, `RELO_APP_URL` shows the landing page and
sign-in lives at `/sign-in`. Keep the token file protected.

The complete server, account, iPhone, APNs, CLI, and Agent Skill installation sequence is in the
repository [README](../README.md#install-relo).

Run every PostgreSQL-backed server test in a disposable database:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile test run --rm integration-test
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile test rm -sf postgres-test
```

After logging the CLI in through the Dashboard, run `relo doctor` and follow its `next` step. Add `--smoke` to enqueue a real
notification; the result deliberately reports server acceptance separately from provider acceptance
and phone receipt.

For a Live Activity that does not appear or update, run
`relo activity diagnose [CARD] --wait --timeout 30s --json`. It reports the last proven
server, APNs, or phone boundary and a safe next action without exposing provider or ActivityKit
token values.
