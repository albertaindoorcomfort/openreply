import { describe, expect, it } from "vitest";
import { playableUrl, recordings } from "@/lib/leads/recordings";

describe("call recordings in the inbox", () => {
  it("plays only https audio on the voice provider's storage", () => {
    expect(playableUrl("https://storage.vapi.ai/abc.wav")).toBe("https://storage.vapi.ai/abc.wav");
    const r2 = "https://94bdb67bb98da30b06bdd917725c037d.r2.cloudflarestorage.com/rec/abc.wav";
    expect(playableUrl(r2)).toBe(r2);
    expect(playableUrl("https://other.r2.cloudflarestorage.com/abc.wav")).toBeNull();
    expect(playableUrl("http://storage.vapi.ai/abc.wav")).toBeNull();
    expect(playableUrl("https://evil.example/vapi.ai.wav")).toBeNull();
    expect(playableUrl("aic:rc-content:1:2")).toBeNull();
    expect(recordings([
      { name: "Call recording", contentType: "audio/wav", url: "https://storage.vapi.ai/a.wav" },
      { name: "photo", contentType: "image/png", url: "https://storage.vapi.ai/b.png" },
      { name: "elsewhere", contentType: "audio/wav", url: "https://evil.example/c.wav" },
    ])).toEqual([{ index: 0, name: "Call recording" }]);
    expect(recordings(null)).toEqual([]);
  });
});
