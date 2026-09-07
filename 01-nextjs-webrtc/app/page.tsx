import VoiceAgent from "@/components/VoiceAgent";

export default function Home() {
  return (
    <main className="page">
      <h1>Silk voice agent</h1>
      <p className="muted">
        Next.js App Router · <code>@livekit/components-react</code> · WebRTC
      </p>
      <VoiceAgent />
    </main>
  );
}
