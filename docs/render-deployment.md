# Render deployment: existing VoIP service

## Verified target (2026-10-04)

- Workspace: My Workspace (explicitly confirmed by the owner).
- Service: `voip-1`, ID `srv-d8vd3dbsq97s7385j670`.
- [Service dashboard](https://dashboard.render.com/web/srv-d8vd3dbsq97s7385j670).
- Public origin: `https://voip-1-87mb.onrender.com`.
- Source: `Yothisislogan/voip`, `main`; native Node, Virginia, one free instance.
- The service is user-suspended. Last successful deployment was the June 26
  build, before the current database/authentication service implementation.
- No managed PostgreSQL instances were listed in this Render workspace. This
  does **not** establish that the service has no external `DATABASE_URL`.
- The older service named `voip` uses a Go runtime. `voip2` is a different repo.
  Neither is the deployment target. Do not resume or modify unrelated services.

## Prepare while the service remains suspended

1. Inspect the target's saved environment variable **names and configured state**
   in the dashboard. Do not print/copy secret values into a ticket, chat or repo.
2. Preserve its current configuration. If `DATABASE_URL` already points to an
   external database, confirm ownership, existing schema and backup/restore
   evidence before migrating it. Do not replace it with an empty database merely
   because Render's database inventory is empty.
3. If no operational database exists, provision a dedicated PostgreSQL database
   in Virginia (or another explicitly approved provider) and securely set its
   connection string. Decide production capacity and backup policy first.
4. Configure the settings in the table below. `sync: false` in `render.yaml`
   prompts only during initial Blueprint creation; updating an existing service
   still requires filling missing values in its Environment tab.
5. Merge the tested release, then apply the build/start/health settings to this
   exact service. An unlinked `render.yaml` does not change Dashboard settings
   automatically. When adopting a Blueprint, review the proposed resource
   identities and avoid accidentally creating duplicates.
6. Resume only after the environment and database are ready. Verify the deploy
   uses the merged release and passes `/ready`, then test login and the phone page.

| Setting | Required value |
| --- | --- |
| Branch | `main` after the reviewed release is merged |
| Runtime / region | Existing Node / Virginia |
| Build command | `npm ci --omit=dev` |
| Start command | `npm run start:render` |
| Health check | `/ready` |
| `NODE_VERSION` | `22` |
| `NODE_ENV` | `production` |
| `AUTH_REQUIRED`, `CSRF_ENABLED` | `true` |
| `DEV_LOGIN_ENABLED` | `false` |
| `PUBLIC_BASE_URL` | `https://voip-1-87mb.onrender.com` unless a verified custom domain replaces it |
| `DATABASE_URL` | Verified operational PostgreSQL connection string |
| `SESSION_SECRET` | Existing strong secret, or securely generated if absent |
| Google OAuth | Client ID/secret and redirect URI `https://voip-1-87mb.onrender.com/auth/google/callback` |
| `AGENT_DIRECTORY` | Verified agency emails, identities, roles and MFA destinations |
| `DEFAULT_AGENT_IDENTITY` | A calling-enabled identity from that directory |
| Twilio | Account SID/auth token, API key/secret, TwiML App SID, caller ID, Verify service |
| Email intake | `EMAIL_INBOUND_TOKEN` when enabled; preserve deliberate existing intake policy |
| WiTnext | URL, provisioned integration ID and its dedicated signing secret |
| Lead signals | Separate `LEAD_SIGNAL_TOKEN` for normalized email/call identity evidence |

The startup wrapper validates production settings **before** migration, runs all
pending migrations, and starts HTTP only after migration success. Keep the
existing database backup: additive migrations and application rollback do not
undo records created by normal operations. Do not run two first-start migrations
concurrently against the same database.

The Blueprint retains the existing free compute plan; no paid resources have
been approved or created by editing this file. Render free services can spin
down, and free databases have expiration/backup limitations. They are not an
appropriate steady-state foundation for a business phone service. Select
always-on compute and a durable database before routing real customer calls.
Do not keep a free service awake with artificial traffic as a substitute.

## Connector and dashboard responsibilities

The connected Render tools can inspect the service, list deployments/logs, set
individual environment variables and trigger a deploy. They currently do not
provide service resume, environment-variable inspection, or changes to the
existing build/start/health settings. Those require the Dashboard or a separately
authorized API/CLI connection. Never infer that configuration is complete from
an old successful deploy or bypass authentication just to make startup succeed.

## Coordinate with WiTnext

VoIP can boot independently after its own migrations and credentials are ready.
For the October matching/Intake improvements, the reviewed WiTnext audit release
includes the earlier handoff release. Deploy its API, worker and web together
with migration 0064 using an updated pinned deployment helper and verified
recovery evidence; do not run the old helper pinned to 0062/0063 unchanged.
The WiTnext server is not among the services found in this Render workspace.

After both sides are ready, verify signed integration delivery with synthetic
records and the [live pilot checklist](voice-service-runbook.md). Do not port
numbers or cancel Dialpad based solely on a green build.

References: [Blueprint updates and existing resources](https://render.com/docs/infrastructure-as-code),
[Blueprint specification](https://render.com/docs/blueprint-spec), and
[free-service limits](https://render.com/docs/free).
