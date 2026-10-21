ALTER TABLE "users"
ADD COLUMN "emulator_controls" JSONB NOT NULL DEFAULT '{}'::jsonb;
