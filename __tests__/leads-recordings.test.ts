import { describe, expect, it } from "vitest";
import { playableUrl, recordings, signedStorageUrl } from "@/lib/leads/recordings";

describe("call recordings in the inbox", () => {
  it("plays only the voice provider's per-call recording route", () => {
    const api = "https://api.vapi.ai/call/call_1/mono-recording";
    expect(playableUrl(api)).toBe(api);
    expect(playableUrl("https://api.vapi.ai/call/call_1/mono-recording?x=1")).toBeNull();
    expect(playableUrl("https://api.vapi.ai/call/../assistant")).toBeNull();
    expect(playableUrl("https://storage.vapi.ai/abc.wav")).toBeNull();
    expect(playableUrl("http://api.vapi.ai/call/call_1/mono-recording")).toBeNull();
    expect(playableUrl("aic:rc-content:1:2")).toBeNull();
    expect(recordings([
      { name: "Call recording", contentType: "audio/wav", url: api },
      { name: "photo", contentType: "image/png", url: api },
      { name: "elsewhere", contentType: "audio/wav", url: "https://evil.example/c.wav" },
    ])).toEqual([{ index: 0, name: "Call recording" }]);
    expect(recordings(null)).toEqual([]);
  });

  it("follows the signed link only onto the provider's storage", () => {
    const r2 = "https://94bdb67bb98da30b06bdd917725c037d.r2.cloudflarestorage.com/rec/abc.wav?X-Amz-Signature=s";
    expect(signedStorageUrl(r2)).toBe(r2);
    const bucket = "https://hipaa-recordings.94bdb67bb98da30b06bdd917725c037d.r2.cloudflarestorage.com/abc.wav?X-Amz-Signature=s";
    expect(signedStorageUrl(bucket)).toBe(bucket);
    expect(signedStorageUrl("https://evil94bdb67bb98da30b06bdd917725c037d.r2.cloudflarestorage.com/abc.wav")).toBeNull();
    expect(signedStorageUrl("https://storage.vapi.ai/abc.wav")).toBe("https://storage.vapi.ai/abc.wav");
    expect(signedStorageUrl("https://other.r2.cloudflarestorage.com/abc.wav")).toBeNull();
    expect(signedStorageUrl("http://storage.vapi.ai/abc.wav")).toBeNull();
    expect(signedStorageUrl(null)).toBeNull();
  });
});
