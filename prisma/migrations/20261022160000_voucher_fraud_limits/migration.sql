-- AlterTable
ALTER TABLE "orders" ADD COLUMN "buyerEmail" TEXT,
ADD COLUMN "cardFingerprint" TEXT;

-- CreateIndex
CREATE INDEX "orders_buyerEmail_idx" ON "orders"("buyerEmail");

-- CreateIndex
CREATE INDEX "orders_cardFingerprint_idx" ON "orders"("cardFingerprint");
