# Agent status and Ringba X availability

WiT Connect now has a colored availability badge per agent and a team status board.
The browser reports phone registration and presence every 25 seconds; the board
refreshes every 15 seconds and on availability changes. After a connected customer
call ends, an agent who was Ready moves to yellow after-call work. The agent
chooses **Green · Ready for calls** when ready for another call.

| Color | Meaning | Counted as available for buying? |
| --- | --- | --- |
| Green | Ready, phone registered, workspace reachable, recent heartbeat, no active call or pending offer | Yes |
| Yellow | Away, after-call work, or capacity reserved for an offered call | No |
| Red | Busy, ringing/dialing, DND, offline, stale/disconnected, or phone setup missing | No |

Both the team board and external API use the same service. Buying availability
requires presence younger than 45 seconds and an authenticated workspace socket
seen within 45 seconds. A revoked login is excluded on the next availability
read, even before the next socket heartbeat. Agents on internal calls are busy.
Queued/dialing/ringing calls are excluded before they answer; a fresh Available
browser heartbeat cannot override server-owned call state or reservations.
Unknown status, missing registration data and database failures never produce
green. Old browser clients must reload to report registration after migration.

## Integration scope

Ringba documents a buyer-owned availability endpoint that its Ring Tree Target
(RTT) pings before sending a call. The RTT's acceptance parser checks the response.
This implementation follows that documented integration pattern:

- [Ringba: Create a Ring Tree Target to Check for Agent Availability](https://support.ringba.com/hc/en-us/articles/22345641522839-Create-a-Ring-Tree-Target-to-Check-for-Agent-Availability)
- [Ringba: Ring Tree Targets](https://support.ringba.com/hc/en-us/articles/25288999168407-Ring-Tree-Targets)

WiT Connect responds to the ping. It does not periodically push statuses to an
undocumented Ringba X URL. The documented Ringba RTT pattern still needs to be
mapped to your specific Ringba X buyer account by its operator/support team.
This endpoint supplies availability, not a price bid, bid ID, delivery number or
purchase confirmation. It does not modify your Ringba account or spend money.

A successful availability response is a **snapshot, not a reservation**. Two
simultaneous pings can both observe the same ready agent. Configure Ringba's
concurrency caps and call-delivery policy before live buying. If your Ringba X
contract requires an atomic ping/confirm reservation or a dynamic bid response,
that adapter and its arrival correlation must be agreed and implemented before
using this endpoint as that contract. POST below only reads availability; it is
not an auction win/confirmation callback. No live Ringba X compatibility or
purchased-call acceptance test has been performed.

## Server configuration

1. Apply migration `0013_agent_readiness.sql` with `npm run migrate` before starting
   this code. The new column defaults false, so nobody is advertised ready until
   the updated phone UI sends a registered heartbeat.
2. Keep one application process/replica, as with the collaboration pilot. Live
   workspace reachability and internal calls are process-local. A restart clears
   readiness until clients reconnect. Multi-replica deployment needs shared
   presence before enabling this endpoint.
3. Set a unique `RINGBA_AVAILABILITY_TOKEN` of at least 32 random characters. This
   is a WiT Connect integration secret, **not a Ringba administrative API token**.
   Supply it via the server's secret environment and the RTT Authorization header.
   Never place it in a URL, frontend code, or repository.
4. Configure explicit pools in `RINGBA_AVAILABILITY_CAMPAIGNS_JSON`, for example:

```json
[
  {"id":"agency","enabled":true,"agents":["alice","bob"]}
]
```

Use real `AGENT_DIRECTORY` identities. Only agents also included in normal inbound
routing (`VOICE_ROUTING_JSON.agents`, or `DEFAULT_AGENT_IDENTITY` when no route is
configured) contribute capacity. Optional pool `timezone`, `hours` and `holidays`
follow the existing voice-routing format. Both pool and global hours must be open.
Disable a pool with `enabled:false` to stop its acceptance signal. Unknown pools
return zero capacity. The API never falls back to an unfiltered agency-wide count.

A pool filters availability counts; it does not create a new DID or change which
agents may answer a delivered call. For an insurance-line/state-specific pool,
configure the corresponding Ringba target and WiT Connect routing to match the
eligible staff before buying traffic. An agent identity/tag alone is not license
or carrier-appointment verification. For the first agency-wide pool, use the same
team as normal inbound routing.

5. Set `RINGBA_AVAILABILITY_ENABLED=true` when ready for integration tests. It
   defaults false. With this flag on, inbound routing also requires the same fresh,
   registered, reachable readiness checks before offering calls.
6. Set `RINGBA_AVAILABILITY_RATE_PER_MINUTE` to the agreed ping volume. Default:
   600 requests per minute (10/sec averaged over the minute), shared by this
   credential across source IPs. This is separate from the browser API budget.
   Invalid credentials have a separate 30/minute/IP limiter. Counters are local to
   this one process and reset on restart. Configure trusted proxy hops correctly.

## Availability request and response

GET (preferred for the availability-only RTT):

```http
GET /integrations/ringba/availability?campaign=agency
Authorization: Bearer <WIT_CONNECT_RINGBA_SECRET>
```

POST alternative (same read-only operation):

```http
POST /integrations/ringba/availability
Authorization: Bearer <WIT_CONNECT_RINGBA_SECRET>
Content-Type: application/json

{"campaign":"agency"}
```

Example response:

```json
{
  "response":{"available":2,"active":3,"accept":true,"status":"green"},
  "campaign":"agency",
  "reason":"available",
  "generatedAt":"2026-10-26T15:00:00.000Z",
  "snapshotOnly":true
}
```

`available` is the number of currently green agents in the eligible pool.
`active` counts agents considered connected to work, including busy/yellow agents;
it is **not buying capacity**. Status is green if any agent is ready, yellow if
none are ready but someone is temporarily unavailable, and red otherwise.
A disabled/closed pool reports red and zero capacity. The public integration
response does not include employee names, identities, phone numbers, call IDs,
customer details or credentials. Authenticated staff can read individual statuses
at `/api/phone/presence/team`.

Configure the Ringba RTT:

- Request URL: `https://YOUR_WIT_CONNECT_HOST/integrations/ringba/availability?campaign=agency`
- HTTP method GET; Authorization header as above.
- Acceptance parsing expression:

```javascript
try {
  var result = JSON.parse(input);
  return result.response.accept === true && Number(result.response.available) > 0;
} catch (error) {
  return false;
}
```

Configure all non-2xx responses, timeouts, malformed JSON, absent fields and
parsing errors as rejection. Never use an old positive response on an error.
Responses carry `Cache-Control: no-store`; the proxy must not cache this endpoint.
The database query has a 750 ms timeout; configure Ringba's HTTP timeout as well,
because connection/pool waits can take longer. Errors return 503 with zero capacity;
rate limiting returns 429 with zero capacity and `Retry-After`. Invalid credentials
return 401, and missing/malformed campaign input returns 400. Disabled, paused,
unknown or closed campaigns return 200 with `accept:false` and zero availability.

Your Ringba target DID, bid price, qualification/conversion event, spend budget,
state/line filters and concurrency limits are configured in Ringba. Those account
settings are not automatically provisioned by this code. The target number must
already be supported by the existing WiT Connect/Telnyx inbound setup.

## Verification

Unit/API/UI tests cover traffic-light rules, missing/stale data, disconnected and
revoked sessions, registration, busy/reserved users, campaign/hours filters,
privacy, failure responses and the separate rate limiter. The database tests
exercise actual presence/call rows and live authenticated workspace WebSockets:

```sh
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
VOIP_TEST_DATABASE_URL="$TEST_DATABASE_URL" node --test test/ringba-availability.integration.test.js
```

Use an isolated test database. Before live buying, check green/yellow/red transitions
against Ringba's actual RTT, login expiry, tab close/network loss, simultaneous
customer/internal calls, paused/closed pools, database failure and rate-limit
rejection. Existing call/provider concurrency tests also remain release gates.
