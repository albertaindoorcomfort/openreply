import type { SocialPlatform } from '@/app/generated/prisma/client';

// Platforms Relay runs DM flows on through Zernio. Each one must deliver
// comment.received and message.received webhooks, accept private replies to
// comments, and return postback button taps, because the automation engine
// relies on all three. Zernio offers private replies and postback/url buttons
// on Instagram and Facebook only, so other networks stay out for now.
export const ZERNIO_PLATFORMS = { instagram: 'INSTAGRAM', facebook: 'FACEBOOK' } as const satisfies Record<string, SocialPlatform>;
export type ZernioPlatform = keyof typeof ZERNIO_PLATFORMS;
export const ZERNIO_PLATFORM_NAMES = Object.keys(ZERNIO_PLATFORMS) as ZernioPlatform[];

export function isZernioPlatform(value: string): value is ZernioPlatform {
  return Object.hasOwn(ZERNIO_PLATFORMS, value);
}

export function zernioPlatformOf(platform: SocialPlatform): ZernioPlatform {
  return platform === 'FACEBOOK' ? 'facebook' : 'instagram';
}
