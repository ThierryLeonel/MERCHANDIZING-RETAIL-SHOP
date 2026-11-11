-- Allow a short grace window for concurrent refresh-token use (multiple tabs).
ALTER TABLE "user_sessions" ADD COLUMN "previous_refresh_hash" TEXT;
ALTER TABLE "user_sessions" ADD COLUMN "rotated_at" TIMESTAMPTZ(6);
