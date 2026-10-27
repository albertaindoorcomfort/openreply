import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connection: vi.fn(), account: vi.fn(), process: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({
  prisma: { zernioConnection: { findUnique: mocks.connection }, instagramAccount: { findFirst: mocks.account } },
}));
vi.mock('@/lib/meta/oauth', () => ({ decryptToken: (value: string) => value }));
vi.mock('@/lib/queue/process-webhook', () => ({ processInstagramWebhook: mocks.process }));

import { POST } from '@/app/api/zernio/webhook/[workspaceId]/route';
import { normalizeZernioEvent } from '@/lib/zernio/normalize-event';
import { parseCommentEvents, parseMessageEvents } from '@/lib/meta/webhook';
import { createInstagramContext, sendDirectMessage, sendPrivateReply } from '@/lib/instagram/provider';

const page = { zernioAccountId: 'zfb', instagramId: 'page1', platform: 'FACEBOOK' as const };
const comment = {
  id: 'evt1', event: 'comment.received', account: { id: 'zfb', platform: 'facebook' },
  comment: { id: 'c1', platformPostId: 'post1', text: 'LINK', author: { id: 'psid1', username: 'reader' } },
};
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  mocks.connection.mockResolvedValue({ webhookId: 'hook', webhookSecret: 'secret', apiKey: 'key' });
  mocks.account.mockResolvedValue(page);
});

describe('Facebook through Zernio', () => {
  it('normalizes Facebook comments and DMs only for the Facebook account', () => {
    const normalized = normalizeZernioEvent({ payload: comment, account: page })!;
    expect(parseCommentEvents(normalized)[0]).toMatchObject({ instagramAccountId: 'page1', commentId: 'c1', commenterId: 'psid1', mediaId: 'post1' });
    const dm = normalizeZernioEvent({ account: page, payload: { id: 'evt2', event: 'message.received', account: { id: 'zfb', platform: 'facebook' }, message: { platformMessageId: 'm1', direction: 'incoming', text: 'LINK', sender: { id: 'psid1' } } } })!;
    expect(parseMessageEvents(dm)[0]).toMatchObject({ instagramAccountId: 'page1', senderId: 'psid1', messageText: 'LINK' });
    expect(normalizeZernioEvent({ payload: comment, account: { ...page, platform: 'INSTAGRAM' } })).toBeNull();
    expect(normalizeZernioEvent({ payload: { ...comment, account: { id: 'zfb', platform: 'whatsapp' } }, account: page })).toBeNull();
  });

  it('routes a signed Facebook webhook to the Facebook account and the shared engine', async () => {
    const rawBody = JSON.stringify(comment);
    const signature = createHmac('sha256', 'secret').update(rawBody).digest('hex');
    const response = await POST(new Request('https://open.example/api/zernio/webhook/ws', { method: 'POST', body: rawBody, headers: { 'x-zernio-signature': signature } }), { params: Promise.resolve({ workspaceId: 'ws' }) });
    expect(response.status).toBe(200);
    expect(mocks.account).toHaveBeenCalledWith({ where: { workspaceId: 'ws', provider: 'ZERNIO', zernioAccountId: 'zfb', platform: 'FACEBOOK' } });
    expect(mocks.process).toHaveBeenCalledWith(expect.objectContaining({ provider: 'ZERNIO', workspaceId: 'ws', payload: expect.objectContaining({ entry: [expect.objectContaining({ id: 'page1' })] }) }));
  });

  it('sends Facebook DMs and private replies through Zernio, never Meta direct', async () => {
    const context = await createInstagramContext({ provider: 'ZERNIO', workspaceId: 'ws', zernioAccountId: 'zfb', instagramId: 'page1', accessToken: '', platform: 'FACEBOOK' });
    expect(context).toMatchObject({ provider: 'ZERNIO', accountId: 'zfb' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ messageId: 'mid1' })));
    await sendDirectMessage({ context, instagramAccountId: 'page1', userId: 'psid1', message: 'hi' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://zernio.com/api/v1/inbox/conversations/psid1/messages');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ accountId: 'zfb', message: 'hi' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ messageId: 'mid2' })));
    await sendPrivateReply({ context, instagramAccountId: 'page1', commentId: 'c1', postId: 'post1', message: 'link' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://zernio.com/api/v1/inbox/comments/post1/c1/private-reply');
    await expect(createInstagramContext({ provider: 'META', workspaceId: 'ws', zernioAccountId: null, instagramId: 'page1', accessToken: 'tok', platform: 'FACEBOOK' })).rejects.toThrow('Only Instagram');
  });
});
