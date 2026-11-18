-- CreateEnum
CREATE TYPE "subscriber_role" AS ENUM ('SUBSCRIBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "usage_type" AS ENUM ('PHONE', 'INTERNET');

-- CreateEnum
CREATE TYPE "bill_status" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID');

-- CreateTable
CREATE TABLE "subscriber" (
    "subscriber_no" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "subscriber_role" NOT NULL DEFAULT 'SUBSCRIBER',

    CONSTRAINT "subscriber_pkey" PRIMARY KEY ("subscriber_no")
);

-- CreateTable
CREATE TABLE "usage_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscriber_no" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "usage_type" "usage_type" NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscriber_no" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "phone_minutes" INTEGER NOT NULL,
    "internet_mb" INTEGER NOT NULL,
    "phone_charge" DECIMAL(10,2) NOT NULL,
    "internet_charge" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "paid_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" "bill_status" NOT NULL DEFAULT 'UNPAID',
    "due_date" DATE NOT NULL,
    "calculated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bill_id" UUID NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_event_subscriber_no_year_month_idx" ON "usage_event"("subscriber_no", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "bill_subscriber_no_year_month_key" ON "bill"("subscriber_no", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transaction_id_key" ON "payment"("transaction_id");

-- CreateIndex
CREATE INDEX "payment_bill_id_idx" ON "payment"("bill_id");

-- AddForeignKey
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_subscriber_no_fkey" FOREIGN KEY ("subscriber_no") REFERENCES "subscriber"("subscriber_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill" ADD CONSTRAINT "bill_subscriber_no_fkey" FOREIGN KEY ("subscriber_no") REFERENCES "subscriber"("subscriber_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written CHECK constraints (ADR #17). Prisma's schema language cannot express
-- them, so they live only here; Prisma's migration diff ignores CHECK constraints and
-- will not try to drop them. zod validation at the API edge is the first line of
-- defence; these guarantee the invariants even for writes that bypass the API.
-- ---------------------------------------------------------------------------

-- AddCheckConstraint: billing period
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_month_check" CHECK ("month" BETWEEN 1 AND 12);
ALTER TABLE "bill" ADD CONSTRAINT "bill_month_check" CHECK ("month" BETWEEN 1 AND 12);

-- AddCheckConstraint: each usage event adds a positive amount (10 min / 1 MB)
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_amount_check" CHECK ("amount" > 0);

-- AddCheckConstraint: aggregated usage on a bill is never negative
ALTER TABLE "bill" ADD CONSTRAINT "bill_phone_minutes_check" CHECK ("phone_minutes" >= 0);
ALTER TABLE "bill" ADD CONSTRAINT "bill_internet_mb_check" CHECK ("internet_mb" >= 0);

-- AddCheckConstraint: money columns are never negative
ALTER TABLE "bill" ADD CONSTRAINT "bill_phone_charge_check" CHECK ("phone_charge" >= 0);
ALTER TABLE "bill" ADD CONSTRAINT "bill_internet_charge_check" CHECK ("internet_charge" >= 0);
ALTER TABLE "bill" ADD CONSTRAINT "bill_total_check" CHECK ("total" >= 0);
ALTER TABLE "bill" ADD CONSTRAINT "bill_paid_amount_check" CHECK ("paid_amount" >= 0);

-- AddCheckConstraint: a payment always moves money
ALTER TABLE "payment" ADD CONSTRAINT "payment_amount_check" CHECK ("amount" > 0);
