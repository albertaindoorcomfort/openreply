import { afterEach, describe, expect, it, vi } from 'vitest';

const ensureDefaultPipeline = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/leads/pipeline', () => ({ ensureDefaultPipeline }));
import { ingestInbound } from '@/lib/leads/ingest';

const actor = { kind: 'SYSTEM' as const, id: 'ringcentral', workspaceId: 'ws' };
const event = (channel: 'CALL' | 'VOICEMAIL' | 'SMS', kind: 'MESSAGE' | 'TRANSCRIPT' = 'MESSAGE') => ({
  channel, kind, channelAccountRef: 'line', externalThreadId: 't1', externalMessageId: 'm1', occurredAt: new Date(),
  from: { identities: [{ kind: 'PHONE' as const, value: '+15875550100' }] }, body: 'hello', attachments: [],
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('RELAY_ACCEPT_CALL_INGEST', () => {
  it('refuses new calls, voicemails and transcripts with 410 CALLS_MOVED when off, and leaves SMS alone', async () => {
    vi.stubEnv('RELAY_ACCEPT_CALL_INGEST', 'off');
    for (const input of [event('CALL'), event('VOICEMAIL'), event('SMS', 'TRANSCRIPT')]) {
      await expect(ingestInbound(actor, input)).rejects.toMatchObject({ code: 'CALLS_MOVED', status: 410 });
    }
    expect(ensureDefaultPipeline).not.toHaveBeenCalled();
    ensureDefaultPipeline.mockRejectedValueOnce(new Error('reached storage'));
    await expect(ingestInbound(actor, event('SMS'))).rejects.toThrow('reached storage');
  });

  it('keeps accepting calls when unset', async () => {
    ensureDefaultPipeline.mockRejectedValueOnce(new Error('reached storage'));
    await expect(ingestInbound(actor, event('CALL'))).rejects.toThrow('reached storage');
  });
});
