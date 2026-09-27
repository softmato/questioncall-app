import { Room as LiveKitRoom, RoomEvent, Track, type RoomOptions } from "livekit-client";

// Everything else the app takes from livekit-client at runtime; its type imports never reach the bundle.
export { ConnectionState, RoomEvent, Track } from "livekit-client";

/**
 * livekit-client for the PWA. On the phone, WebRTC plays the other person's
 * voice by itself; in a browser a remote audio track is silent until it is
 * attached to an <audio> element. This Room does that for every call the app
 * opens (components/calls/call-screen.tsx, lib/call-prewarm.ts), and takes the
 * elements down when the tracks go.
 */
export class Room extends LiveKitRoom {
  constructor(options?: RoomOptions) {
    super(options);

    this.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) document.body.append(track.attach());
    });
    this.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio)
        track.detach().forEach((element) => element.remove());
    });
    this.on(RoomEvent.Disconnected, () => {
      this.remoteParticipants.forEach((participant) =>
        participant.audioTrackPublications.forEach((publication) =>
          publication.track?.detach().forEach((element) => element.remove()),
        ),
      );
    });
  }
}
