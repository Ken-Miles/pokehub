-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PLAYER', 'MOD', 'ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED');

-- CreateEnum
CREATE TYPE "EmailTokenKind" AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD');

-- CreateEnum
CREATE TYPE "FriendshipStatus" AS ENUM ('PENDING', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "SlotOrigin" AS ENUM ('NEW', 'IMPORTED');

-- CreateEnum
CREATE TYPE "SaveSource" AS ENUM ('EMULATOR', 'IMPORT', 'TRADE', 'RESTORE', 'ADMIN');

-- CreateEnum
CREATE TYPE "PokemonOrigin" AS ENUM ('NATIVE', 'IMPORTED');

-- CreateEnum
CREATE TYPE "RegistryStatus" AS ENUM ('OK', 'CLONE_SUSPECT', 'FROZEN');

-- CreateEnum
CREATE TYPE "TradeState" AS ENUM ('OPEN', 'COMMITTING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'DISMISSED', 'ACTIONED');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'PLAYER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "friendCode" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "acceptUnverified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "EmailTokenKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "username" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "friendships" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" "FriendshipStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "game_slots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slotNumber" INTEGER NOT NULL,
    "gameCode" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "origin" "SlotOrigin" NOT NULL,
    "trainerName" TEXT,
    "trainerId" INTEGER,
    "secretId" INTEGER,
    "currentVersionId" TEXT,
    "lastTradeVersionId" TEXT,
    "lockedByTradeId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "save_versions" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "parentId" TEXT,
    "seq" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "playSeconds" INTEGER NOT NULL,
    "source" "SaveSource" NOT NULL,
    "tradeId" TEXT,
    "restoredFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "save_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pokemon_registry" (
    "fingerprint" TEXT NOT NULL,
    "species" INTEGER NOT NULL,
    "otName" TEXT NOT NULL,
    "tid" INTEGER NOT NULL,
    "sid" INTEGER NOT NULL,
    "currentSlotId" TEXT,
    "origin" "PokemonOrigin" NOT NULL,
    "status" "RegistryStatus" NOT NULL DEFAULT 'OK',
    "firstSeenVersionId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pokemon_registry_pkey" PRIMARY KEY ("fingerprint")
);

-- CreateTable
CREATE TABLE "pokemon_sightings" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "species" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "box" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pokemon_sightings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "state" "TradeState" NOT NULL DEFAULT 'OPEN',
    "aSlotId" TEXT NOT NULL,
    "bSlotId" TEXT,
    "aBaseVersionId" TEXT,
    "bBaseVersionId" TEXT,
    "aOffer" JSONB,
    "bOffer" JSONB,
    "aConfirmedAt" TIMESTAMP(3),
    "bConfirmedAt" TIMESTAMP(3),
    "aResultVersionId" TEXT,
    "bResultVersionId" TEXT,
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "save_flags" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "save_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "targetTradeId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_friendCode_key" ON "users"("friendCode");

-- CreateIndex
CREATE UNIQUE INDEX "email_tokens_tokenHash_key" ON "email_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "email_tokens_userId_idx" ON "email_tokens"("userId");

-- CreateIndex
CREATE INDEX "auth_events_userId_createdAt_idx" ON "auth_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "friendships_addresseeId_idx" ON "friendships"("addresseeId");

-- CreateIndex
CREATE UNIQUE INDEX "friendships_requesterId_addresseeId_key" ON "friendships"("requesterId", "addresseeId");

-- CreateIndex
CREATE UNIQUE INDEX "game_slots_currentVersionId_key" ON "game_slots"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "game_slots_lastTradeVersionId_key" ON "game_slots"("lastTradeVersionId");

-- CreateIndex
CREATE INDEX "game_slots_userId_idx" ON "game_slots"("userId");

-- CreateIndex
CREATE INDEX "save_versions_tradeId_idx" ON "save_versions"("tradeId");

-- CreateIndex
CREATE UNIQUE INDEX "save_versions_slotId_seq_key" ON "save_versions"("slotId", "seq");

-- CreateIndex
CREATE INDEX "pokemon_registry_currentSlotId_idx" ON "pokemon_registry"("currentSlotId");

-- CreateIndex
CREATE INDEX "pokemon_sightings_fingerprint_createdAt_idx" ON "pokemon_sightings"("fingerprint", "createdAt");

-- CreateIndex
CREATE INDEX "trades_state_expiresAt_idx" ON "trades"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "save_flags_status_createdAt_idx" ON "save_flags"("status", "createdAt");

-- CreateIndex
CREATE INDEX "reports_status_createdAt_idx" ON "reports"("status", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_targetType_targetId_idx" ON "audit_events"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "audit_events_actorId_createdAt_idx" ON "audit_events"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_slots" ADD CONSTRAINT "game_slots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_slots" ADD CONSTRAINT "game_slots_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "save_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_slots" ADD CONSTRAINT "game_slots_lastTradeVersionId_fkey" FOREIGN KEY ("lastTradeVersionId") REFERENCES "save_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_slots" ADD CONSTRAINT "game_slots_lockedByTradeId_fkey" FOREIGN KEY ("lockedByTradeId") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "save_versions" ADD CONSTRAINT "save_versions_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "game_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "save_versions" ADD CONSTRAINT "save_versions_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "save_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pokemon_registry" ADD CONSTRAINT "pokemon_registry_currentSlotId_fkey" FOREIGN KEY ("currentSlotId") REFERENCES "game_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pokemon_sightings" ADD CONSTRAINT "pokemon_sightings_fingerprint_fkey" FOREIGN KEY ("fingerprint") REFERENCES "pokemon_registry"("fingerprint") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pokemon_sightings" ADD CONSTRAINT "pokemon_sightings_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "save_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_aSlotId_fkey" FOREIGN KEY ("aSlotId") REFERENCES "game_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_bSlotId_fkey" FOREIGN KEY ("bSlotId") REFERENCES "game_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "save_flags" ADD CONSTRAINT "save_flags_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "save_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------- hand-written

-- FR-10: slot numbers are unique per user among live (not soft-deleted) slots.
CREATE UNIQUE INDEX "game_slots_user_slot_live_key"
  ON "game_slots" ("userId", "slotNumber")
  WHERE "deletedAt" IS NULL;

-- FR-24: the audit log is append-only.
CREATE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- NFR-07: a save version's blob and hash never change.
CREATE FUNCTION save_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."storageKey" <> OLD."storageKey" OR NEW."sha256" <> OLD."sha256" OR NEW."slotId" <> OLD."slotId" OR NEW."seq" <> OLD."seq" THEN
    RAISE EXCEPTION 'save_versions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER save_versions_no_rewrite
  BEFORE UPDATE ON "save_versions"
  FOR EACH ROW EXECUTE FUNCTION save_versions_immutable();
