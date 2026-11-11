-- AlterTable
ALTER TABLE "promo_codes" ADD COLUMN "allowFullDiscount" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "freeCheckout" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "fulfillmentMetadata" JSONB;
