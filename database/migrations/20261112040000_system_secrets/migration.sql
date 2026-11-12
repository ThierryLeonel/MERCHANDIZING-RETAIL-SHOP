-- Application-generated runtime secrets (used when JWT_SECRET is not provided by the environment).
CREATE TABLE "system_secrets" (
  "key" VARCHAR(64) NOT NULL,
  "value" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "system_secrets_pkey" PRIMARY KEY ("key")
);
