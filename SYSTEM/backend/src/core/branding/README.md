# Core branding storage

`system.branding` is the single Bonni Core setting for the visible organization
name and logo. Apps receive only its public DTO; they do not own or mutate the
asset.

Logo uploads accept only PNG, at most 2 MiB and 2048 × 2048 pixels. Bonni does
not depend on a native image codec for this boundary. Instead it validates the
complete PNG structure and every CRC, inflates and validates every scanline,
requires the zlib stream to consume every IDAT byte, rejects APNG and unknown
critical chunks, and persists a sanitized PNG that
retains only rendering-critical chunks plus valid palette transparency. Text,
profiles and all other ancillary metadata are stripped. The compressed pixel
stream is not re-encoded.

Indexed-color PNGs are rejected. The active logo's media capability is
revocable: the dedicated anonymous `GET /api/branding/logo/:mediaId` route
checks exact Core ownership, PNG type, ID and SHA-256 against the atomically
written persistent branding snapshot. It does not expose the general media
router before login. A replaced asset is unavailable immediately on Active,
Local and Emergency even if physical cleanup must be retried. Cleanup failures
create a persistent Core audit entry instead of being silently ignored.

Only the authoritative Active surface mutates `system.branding`. Its committed
revision is deterministically replicated in database mode `both` and only then
published as the persistent read-only snapshot used by Local and Emergency;
those surfaces never read branding from `LOCAL_DATABASE_URL`. Branding changes
and the database-plus-storage backup snapshot phase share a heartbeat-backed,
cross-process filesystem lock. This prevents a backup database reference from
outliving the corresponding copied logo. Lock artifacts are excluded from the
backup itself.

If the authoritative database commit succeeds but replica or snapshot
publication temporarily fails, the mutation reports a committed 503 and keeps
the last complete snapshot public. The next Active public read retries the
exact committed revision under the same lock, repairs replica and snapshot,
then revokes/cleans the previous logo. It never publishes a DTO whose logo
capability is still unauthorized.

Snapshot revisions are monotonic across database failover. A routed database
which is behind the snapshot, or disagrees at the same revision, is audited and
cannot overwrite the snapshot or accept an admin mutation until it is synced.
Physical media cleanup is independently fail-closed: every configured normal
and redundant database must prove it no longer references the old media ID.
The same proof is required for a newly created object after a transaction
connection error: PostgreSQL may have committed before its acknowledgement was
lost, so an apparently "uncommitted" logo is retained and audited whenever the
outcome cannot be proven safe. A later Active read converges that committed row
into replica and snapshot normally.

The PostgreSQL full-sync operation holds the same persistent snapshot lock from
before maintenance activation and `pg_dump` through target restore and
maintenance completion. Lock ordering is consistently persistent lock first,
database maintenance second. Branding explicitly invokes the database
write-maintenance guard before its routed transaction, because routed Prisma
transactions otherwise bind through read order.

Branding identity monotonicity is independent from media availability. If the
database and snapshot name the same revision and logo but its immutable bytes
are missing or corrupt, Core atomically publishes a same-revision
`logo: null, fallback: true` snapshot. Local and Emergency therefore never
receive a URL which the logo endpoint rejects. The snapshot retains the exact
media ID and digest as an unavailable, non-authorized latent reference; this
prevents an equal-revision database with another logo from being mistaken for
recovery. The marker still permits an admin reset, and only that exact
capability is deterministically restored at the same revision when its verified
media becomes readable again. Snapshot-only and database-error reads also
verify availability without rewriting the durable snapshot, so a temporary
storage outage preserves text, revision and automatic recovery.

The public endpoint intentionally falls back to the bundled original Bonni
mark whenever the database, setting or stored media is unavailable. A branding
failure therefore never blocks the login screen.
