-- FR-36 / ADR-023: test bots
ALTER TABLE "users" ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false;
