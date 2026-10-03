-- AlterEnum
ALTER TYPE "ProductType" ADD VALUE 'HEALTHCARE';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "details" JSONB;
