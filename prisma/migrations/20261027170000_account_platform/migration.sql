-- Connected accounts carry their social platform. Existing rows are Instagram.
CREATE TYPE "SocialPlatform" AS ENUM ('INSTAGRAM', 'FACEBOOK');
ALTER TABLE "InstagramAccount" ADD COLUMN "platform" "SocialPlatform" NOT NULL DEFAULT 'INSTAGRAM';
