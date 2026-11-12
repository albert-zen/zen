# Optional self-hosted Fleet relay

Fleet can use a trusted HTTPS relay when two devices cannot directly reach one
another. It requires no vendor account or paid plan. This repository contains the
relay and outbound Host bridge; deploying a public relay, acquiring a certificate,
and provisioning credentials remain explicit administrator actions. Nothing is
deployed or registered externally by enabling the code.

The native Host remains the only authority for pairing, device grants, workspace
access, read/control permissions, RPC admission, events and revocation. The relay
holds only bounded live tunnels and requests in memory. It does not mirror
conversations, write credentials, or replay requests. Local AppServer descriptors
and bearer credentials never enter this transport.

## Trust and topology

Both hops use authenticated TLS with normal hostname/certificate validation:

1. The remote desktop Host opens an outbound WSS tunnel to
   `https://relay.example` at `/fleet/register`
2. A desktop or mobile native client uses that relay's HTTPS authority as its
   Fleet peer endpoint, with the actual remote Host's stable `hostId`
3. The relay uses `x-zen-host-id` to select exactly one pre-provisioned live tunnel
4. The Host bridge forwards only `/pair` and `/remote` to its fixed local native
   TLS gateway. It cannot be instructed to fetch a URL or arbitrary route
5. Native `/remote` authenticates the client's existing device ID and bearer
   grant, then the native hello response confirms the actual Host identity

The relay terminates TLS and can see pairing codes, issued device grants,
messages, responses and events. A compromised relay can misuse grants that pass
through it. This is **not end-to-end encryption**. Use only a relay/operator you
trust with that access. Transport TLS does not replace device revocation. Revoke
native grants if relay confidentiality is lost, and rotate the separately
provisioned Host registration credential if needed.

Each Host has its own high-entropy registration secret. Administrators put its
SHA-256 digest in the relay inventory; the Host stores the original secret in its
protected credential store. Registration requires a matching Host ID and constant-
time comparison of the supplied token's digest. Unknown IDs, wrong credentials
and a second live registration for the same ID are rejected. Registration secrets
are not client device grants and are never forwarded to the native gateway.

## Relay configuration and CLI

From an installed repository, run:

```sh
node --import tsx apps/zenx/src/main/fleet-relay-cli.ts \
  --config /absolute/path/private-relay.json
```

The configuration must be a regular, non-symlink file. On POSIX it must belong to
the running user with no group/other permission bits, for example mode `0600`.
TLS key files have the same requirement. Windows operators must restrict the
config and key with their account's filesystem ACLs. Paths are absolute; no
implicit environment variable or credential fallback is used.

```json
{
  "version": 1,
  "enabled": true,
  "listen": "127.0.0.1",
  "port": 8443,
  "tlsCertificateFile": "/absolute/path/relay-fullchain.pem",
  "tlsKeyFile": "/absolute/path/relay-key.pem",
  "registrations": [
    {
      "hostId": "desktop-home",
      "tokenSha256": "<64 lowercase hexadecimal SHA-256 characters>"
    }
  ]
}
```

Use an existing administrator-owned server and a certificate trusted by the
client devices. Changing `listen` to a public bind address exposes a service and
should be done deliberately with the operator's firewall/TLS configuration. The
program has no plaintext HTTP listener. TLS offload to an untrusted or plaintext
upstream is not supported. For a public authority, supply the externally reachable
relay endpoint to Hosts/clients rather than the CLI's bind-address display.

Generate a unique registration secret with at least 32 random bytes through a
trusted local credential-management workflow, then provision only its SHA-256 hex
digest at the relay. Tokens accept URL-safe letters/digits/underscore/hyphen;
never put the original token in a URL, command-line argument, shared config,
terminal transcript, or source control. The server writes only its startup
endpoint and generic startup/shutdown failure messages, with no access log or
request-body logging. Protect any reverse proxy or monitoring system from
logging authorization headers or bodies as well.

Only the listed config fields are accepted. The maximum inventory is 64 Hosts.
An optional `originEndpoint` can name one exact HTTPS authority whose same-origin
browser WebSocket upgrades may be accepted; matching the incoming Host header is
also required. Pairing POSTs with any Origin header remain rejected, matching the
native endpoint contract. Native desktop/mobile clients do not send that header.

## Host and client integration

`connectFleetRelayHost` takes:

- `hostId`: the native Host's stable identity, not a display name
- `relayEndpoint`: an explicit HTTPS authority with no credentials/path/query/hash
- `registrationToken`: the secret from protected Host storage
- `nativeEndpoint`: the Host-derived fixed loopback HTTPS authority
- `nativeCa`: an explicit trusted certificate/CA for that local gateway when it
  uses a private TLS identity
- `nativeServerName` (optional): the administrator-selected certificate identity
  to validate while the TCP destination remains loopback
- `ca` (optional): an explicit private relay CA; no skip-validation switch exists

The native local authority must be `127.0.0.1`, `[::1]` or `localhost`; it cannot
come from a client request. Prefer numeric loopback with `nativeServerName` when
that certificate is issued for a Host DNS name. The Host derives the loopback
port from its own running gateway. Connecting to either TLS identity unsuccessfully
fails explicitly, without fallback to HTTP or disabled validation.

`serveFleetRelay` returns `{ endpoint, close() }`.
`connectFleetRelayHost` returns `{ closed, close() }`; `closed` resolves on explicit
shutdown or a tunnel failure. Host lifecycle code may reconnect the transport
only. It must not retry a pairing operation or replay send/control requests after
an uncertain result. Neither API creates accounts, persists credentials, changes
network policy, or enrolls client devices.

Native client pairing and WebSocket handshakes include `x-zen-host-id`, plus the
normal device ID and bearer headers for `/remote`. A client grant stays bound to
both the intended native Host identity and the chosen relay endpoint. Switching
the endpoint needs fresh pairing. Ordinary native workspace, models, rooms,
thread recovery, events and control traffic stay on the same protocol; the relay
does not select or prune native RPC methods.

## Bounds and failure behavior

- 128 incoming TCP sockets, 16 unadmitted TLS sockets/pending operations,
  64 active client sessions total, and 32 sessions per registered Host
- Pair requests: 2 KiB; pair responses: 4 KiB
- Native client text frames: 64 KiB; Host response/event frames: 2 MiB
- Internal base64 tunnel frames: 3 MiB; outgoing queued data: 4 MiB
- TLS handshake/operation deadlines: 5 seconds by default; absolute deadlines
  cover slow trickle requests and the local native gateway
- Outbound reverse tunnels use ping/pong liveness checks every 30 seconds

An offline Host yields `503`; native device rejection is retained as `401`/`403`
before the client WebSocket is admitted. Capacity returns `429`, a failed hop
returns `502`, and an operation deadline returns `504`. Native device revocation
close code `4003` propagates to the affected client. Disconnects close associated
requests/streams; another registered Host stays isolated. Oversized/binary native
requests are rejected; slow receivers are disconnected rather than buffered
without a bound. A timeout or disconnect can leave pairing-code consumption or
mutation admission unknown. Inspect the target/fresh native state before a
manual retry. No automatic mutation or pairing retry is performed.

## Verification

```sh
node --import tsx --test apps/zenx/test/fleet-relay.test.ts
```

Tests generate a one-invocation localhost certificate, explicitly trust it, and
run TLS fixtures on numeric loopback only. They exercise two-Host routing,
pairing, device rejection, full native response capacity, room events, revocation,
offline behavior, registration takeover rejection, deadlines, strict Origins,
private CLI config, and real native Fleet client identity checks. Self-signed
identities fail without the explicitly injected fixture CA; TLS hostname
mismatches fail even with that CA. There is no rejection bypass or real secret.
