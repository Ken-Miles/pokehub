-- AlterTable (additive: the live colour keeps working while this runs)
ALTER TABLE "link_sessions" ADD COLUMN "relayOwner" TEXT;
