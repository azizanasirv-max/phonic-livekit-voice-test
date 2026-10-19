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
 *   LIVEKIT_URL             wss://<project>.livekit.cloud
 *   LIVEKIT_TOKEN           short-lived participant token (never logged)
 *   LIVEKIT_ROOM            room to join
 *   SMOKE_TIMEOUT_MS        how long to wait for the agent (default 120000)
 *   SMOKE_OBSERVE_MS        how long to watch connection quality (default 5000)
 *   SMOKE_EXPECT_AGENT_NAME optional explicit-dispatch agent name. When set,
 *                           only a participant whose `lk.agent.name` attribute
 *                           matches is accepted, so another agent in the same
 *                           project cannot make this test pass.
 *
 * Exit code 0 only when the expected agent participant joins the room.
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
// Optional: require the joining agent to advertise this explicit-dispatch name.
const expectedAgentName = process.env.SMOKE_EXPECT_AGENT_NAME?.trim() || undefined;

/** Agent participants carry their explicit-dispatch name in this attribute. */
const AGENT_NAME_ATTRIBUTE = 'lk.agent.name';

type ParticipantLike = {
  identity: string;
  attributes: Record<string, string>;
};

/** True when the participant is the agent this smoke test targets. */
function isExpectedAgent(participant: ParticipantLike): boolean {
  if (expectedAgentName === undefined) return true;
  return participant.attributes[AGENT_NAME_ATTRIBUTE] === expectedAgentName;
}

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

/** Poll until the expected agent participant is present. */
async function waitForRemoteParticipant(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const ignored = new Set<string>();

  while (Date.now() < deadline) {
    for (const participant of room.remoteParticipants.values()) {
      if (isExpectedAgent(participant)) return participant;

      if (!ignored.has(participant.identity)) {
        ignored.add(participant.identity);
        const actual = participant.attributes[AGENT_NAME_ATTRIBUTE] ?? '(none)';
        console.log(
          `ignoring participant identity=${participant.identity} agent=${actual} ` +
            `(waiting for agent=${expectedAgentName})`,
        );
      }
    }
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
    const expected =
      expectedAgentName === undefined
        ? 'any agent participant'
        : `agent "${expectedAgentName}" (attribute ${AGENT_NAME_ATTRIBUTE})`;
    console.error(
      `FAIL: ${expected} did not join room=${roomName} within ${waitMs} ms. ` +
        'Check that the deployed test agent is running with LIVEKIT_AGENT_NAME set to ' +
        'that value and that the token requested explicit dispatch.',
    );
  } else {
    console.log(
      `agent participant joined: identity=${participant.identity} ` +
        `name=${participant.name ?? '(none)'} kind=${participant.kind} ` +
        `agent=${participant.attributes[AGENT_NAME_ATTRIBUTE] ?? '(none)'}`,
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
