"use client";

import type { TranscriptionSegment } from "livekit-client";

// Rendered only when the agent publishes transcriptions on its audio track.
// Not every agent configuration does; if nothing shows up here your audio is
// still fine — transcripts are enrichment, not a dependency.
export function Transcript({ segments }: { segments: TranscriptionSegment[] }) {
  if (!segments?.length) return null;
  return (
    <div className="transcript">
      {segments.map((s) => (
        <p key={s.id} style={{ opacity: s.final ? 1 : 0.6 }}>
          <span className="role">agent</span>
          {s.text}
        </p>
      ))}
    </div>
  );
}
