-- An account has a holder only while a company holds it: an unclaimed account
-- at the bank is not in anybody's name yet. Claiming one (POST /accounts/verify
-- with a companyId) sets the holder to the owner of that company; releasing it
-- (POST /accounts/:iban/unlink) clears it again.

-- AlterTable
ALTER TABLE "Account" ALTER COLUMN "holderName" DROP NOT NULL;

-- Bring existing rows in line with the rule rather than forcing a re-seed:
-- every account no company has claimed loses its holder.
UPDATE "Account" SET "holderName" = NULL WHERE "companyId" IS NULL;
