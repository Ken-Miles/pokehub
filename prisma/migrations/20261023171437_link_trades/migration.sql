-- FR-37: in-game link trades, for admins
-- CreateTable
CREATE TABLE "link_trades" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "mode" "LinkMode" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "species" INTEGER NOT NULL,
    "speciesName" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "fromSlotId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "toSlotId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "link_trades_createdAt_idx" ON "link_trades"("createdAt");

-- CreateIndex
CREATE INDEX "link_trades_fromUserId_createdAt_idx" ON "link_trades"("fromUserId", "createdAt");

-- CreateIndex
CREATE INDEX "link_trades_toUserId_createdAt_idx" ON "link_trades"("toUserId", "createdAt");

-- CreateIndex
CREATE INDEX "link_trades_fingerprint_idx" ON "link_trades"("fingerprint");

-- Trade history is append-only, like audit_events.
CREATE FUNCTION link_trades_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'link_trades is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER link_trades_no_update_delete
  BEFORE UPDATE OR DELETE ON "link_trades"
  FOR EACH ROW EXECUTE FUNCTION link_trades_append_only();
