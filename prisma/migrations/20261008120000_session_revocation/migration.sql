CREATE TABLE "SessionRevocation" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SessionRevocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SessionRevocation_tokenId_key" ON "SessionRevocation" ("tokenId");
CREATE INDEX "SessionRevocation_userId_idx" ON "SessionRevocation" ("userId");
