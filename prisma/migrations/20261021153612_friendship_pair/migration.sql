-- ---------------------------------------------------------------- hand-written

-- FR-03: at most one friendship per pair of users, whichever way it was sent,
-- so two players asking each other at the same moment can't make two rows.
CREATE UNIQUE INDEX "friendships_pair_key"
  ON "friendships" (LEAST("requesterId", "addresseeId"), GREATEST("requesterId", "addresseeId"));

-- FR-03: a user can't block themselves.
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_not_self" CHECK ("blockerId" <> "blockedId");
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_not_self" CHECK ("requesterId" <> "addresseeId");
