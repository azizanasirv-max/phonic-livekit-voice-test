/**
 * LiveKit room-connection smoke test.
 *
 * Joins a temporary room with a subscribe-only participant and waits for the
 * deployed agent to join it. This proves that the deployed worker is healthy,
 * accepts a real job from LiveKit Cloud and connects to the room. It does *not*
 * publish microphone audio, so it cannot prove speech recognition, spoken
 * output or interruption behaviour — the manual Agent Console test in the
 * README covers those.
 *
 * Environment:
 *   LIVEKIT_URL           wss://<project>.livekit.cloud
 *   LIVEKIT_TOKEN         short-lived participant token (never logged)
 *   LIVEKIT_ROOM          room to join
 *   SMOKE_TIMEOUT_MS      how long to wait for the agent (default 120000)
 *   SMOKE_OBSERVE_MS      how long to watch connection quality (default 5000)
 *
 * Exit code 0 only when another participant (the agent) joins the room.
 */
import { Room, RoomEvent } from '@livekit/rtc-node';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const url = requireEnv('LIVEKIT_URL');
const token = requireEnv('LIVEKIT_TOKEN');
const roomName = requireEnv('LIVEKIT_ROOM');
const waitMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS ?? '120000', 10);
const observeMs = Number.parseInt(process.env.SMOKE_OBSERVE_MS ?? '5000', 10);

const room = new Room();

room.on(RoomEvent.ConnectionStateChanged, (state) => {
  console.log(`connection state: ${state}`);
});
room.on(RoomEvent.Reconnecting, () => {
  console.log('connection state: reconnecting');
});
room.on(RoomEvent.Reconnected, () => {
  console.log('connection state: reconnected');
});
room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
  console.log(`connection quality: participant=${participant.identity} quality=${quality}`);
});
room.on(RoomEvent.ParticipantDisconnected, (participant) => {
  console.log(`participant left: ${participant.identity}`);
});

/** Poll until any remote participant (the agent) is present. */
async function waitForRemoteParticipant(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [first] = room.remoteParticipants.values();
    if (first !== undefined) return first;
    await delay(500);
  }
  return undefined;
}

let exitCode = 1;

try {
  // Subscribe-only: this client does not publish audio, so no microphone or
  // audio device is required on the runner.
  await room.connect(url, token, { autoSubscribe: false, dynacast: false });
  console.log(
    `connected: room=${room.name ?? roomName} identity=${room.localParticipant?.identity ?? '(unknown)'}`,
  );

  const participant = await waitForRemoteParticipant(waitMs);
  if (participant === undefined) {
    console.error(
      `FAIL: no agent participant joined room=${roomName} within ${waitMs} ms. ` +
        'Check that the deployed agent uses automatic dispatch, or that LIVEKIT_AGENT_NAME is ' +
        'configured for explicit dispatch.',
    );
  } else {
    console.log(
      `agent participant joined: identity=${participant.identity} ` +
        `name=${participant.name ?? '(none)'} kind=${participant.kind}`,
    );
    // Give LiveKit's connection-quality reporting a moment to arrive. Audio
    // packet loss, jitter and RTT are only measurable with a published media
    // track, which this smoke test deliberately does not create.
    await delay(observeMs);
    console.log('smoke test passed: the deployed agent joined a real LiveKit room');
    exitCode = 0;
  }
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await room.disconnect().catch(() => undefined);
}

process.exitCode = exitCode;
