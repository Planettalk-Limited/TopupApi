-- Country and city were collected by the old Netlify careers form; restored so its
-- applications import losslessly and the new form can collect them again.
ALTER TABLE "job_applications" ADD COLUMN "country" TEXT,
ADD COLUMN "city" TEXT;
