-- CreateEnum
CREATE TYPE "LinkMode" AS ENUM ('SAME_DEVICE', 'NETWORK');

-- CreateEnum
CREATE TYPE "LinkState" AS ENUM ('LOBBY', 'ACTIVE', 'ENDED');

-- CreateTable
CREATE TABLE "link_sessions" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "mode" "LinkMode" NOT NULL,
    "state" "LinkState" NOT NULL DEFAULT 'LOBBY',
    "rtcEpochMs" BIGINT,
    "inputDelay" INTEGER,
    "coreBuild" TEXT,
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "link_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_seats" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "slotId" TEXT,
    "romSha1" TEXT,
    "coreBuild" TEXT,
    "readyAt" TIMESTAMP(3),
    "startVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_seats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "link_sessions_state_createdAt_idx" ON "link_sessions"("state", "createdAt");

-- CreateIndex
CREATE INDEX "link_sessions_hostId_idx" ON "link_sessions"("hostId");

-- CreateIndex
CREATE INDEX "link_seats_slotId_idx" ON "link_seats"("slotId");

-- CreateIndex
CREATE INDEX "link_seats_userId_idx" ON "link_seats"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "link_seats_sessionId_seat_key" ON "link_seats"("sessionId", "seat");

-- CreateIndex
CREATE UNIQUE INDEX "link_seats_sessionId_slotId_key" ON "link_seats"("sessionId", "slotId");

-- AddForeignKey
ALTER TABLE "link_sessions" ADD CONSTRAINT "link_sessions_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_seats" ADD CONSTRAINT "link_seats_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "link_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_seats" ADD CONSTRAINT "link_seats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "link_seats" ADD CONSTRAINT "link_seats_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "game_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
